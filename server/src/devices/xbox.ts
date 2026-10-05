import { randomUUID } from 'node:crypto';
import type { DeviceConfig } from '../config.js';
import {
  SMARTGLASS_PORT,
  discoveryRequest,
  parseDiscoveryResponse,
  powerOnRequest,
} from '../protocols/smartglass.js';
import { BadRequestError, NeedsSetupError } from '../errors.js';
import {
  DeviceAdapter,
  UnsupportedCommandError,
  bool,
  type Capability,
  type CommandResult,
  type CommandSpec,
  type DeviceContext,
  type DeviceState,
} from './types.js';

type XboxConfig = Extract<DeviceConfig, { type: 'xbox' }>;

const MS_LOGIN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const MS_SCOPE = 'XboxLive.signin offline_access';
const XBL_USER_AUTH = 'https://user.auth.xboxlive.com/user/authenticate';
const XBL_XSTS = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const XCCS = 'https://xccs.xboxlive.com';

/** XSTS error codes worth explaining to a human. */
const XERR_NO_XBOX_PROFILE = 2148916233;
const XERR_CHILD_ACCOUNT = 2148916238;

interface MsTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface PendingSignIn {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

interface XblTokenResponse {
  Token?: string;
  NotAfter?: string;
  DisplayClaims?: { xui?: Array<{ uhs?: string }> };
  XErr?: number;
}

interface CloudConsole {
  id: string;
  name?: string;
  consoleType?: string;
  powerState?: string;
}

interface MsTokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/**
 * Xbox One S, two ways:
 *
 * Local (always available): the unauthenticated part of SmartGlass on UDP/5050.
 * Discovery reports whether the console is awake and a power-on packet wakes
 * it from standby. Over Wi-Fi many consoles stop listening for that packet in
 * standby, so local wake is unreliable there.
 *
 * Cloud (optional, after Pair): the same Xbox Live console-management service
 * the Xbox mobile app uses. A sleeping console keeps a connection to Xbox Live
 * open, so cloud wake works over Wi-Fi, and it is the only way to turn the
 * console *off*. Sign-in uses the Microsoft device-code flow: the hub shows a
 * code, you enter it at microsoft.com/link. Only the refresh token is stored
 * (in the state file); the password never reaches the Pi.
 *
 * Cloud needs XBOX_CLIENT_ID in the environment: the client ID of an Azure app
 * registration (personal Microsoft accounts, public client flows enabled). This
 * is an unofficial API and may change without notice.
 */
export class XboxAdapter extends DeviceAdapter {
  readonly type = 'xbox';
  readonly icon = 'xbox';
  readonly capabilities: Capability[] = ['power', 'wake', 'sensors'];

  private liveId: string | undefined;
  private msTokens: MsTokens | undefined;
  private pending: PendingSignIn | undefined;
  private xbl: { header: string; expiresAt: number } | undefined;
  private refreshing: Promise<void> | null = null;

  constructor(ctx: DeviceContext, private readonly cfg: XboxConfig) {
    super(ctx);
    this.pollIntervalMs = (cfg.pollSeconds ?? 20) * 1000;
  }

  private get ns(): string {
    return `xbox:${this.id}`;
  }

  override async init(): Promise<void> {
    this.liveId = this.cfg.liveId ?? this.ctx.store.get<string>(this.ns, 'liveId');
    this.msTokens = this.ctx.store.get<MsTokens>(this.ns, 'msTokens');
    this.pending = this.ctx.store.get<PendingSignIn>(this.ns, 'pending');
  }

  override setupHint(): string | undefined {
    const hints: string[] = [];
    if (!this.liveId) {
      hints.push(
        'Turn the console on and press Refresh: the hub reads its live ID from the discovery response and remembers it.',
      );
    }
    if (!process.env['XBOX_CLIENT_ID']) {
      hints.push(
        'For power off and reliable wake over Wi-Fi, register an Azure app and set XBOX_CLIENT_ID in /etc/pi-smart-home-hub.env.',
      );
    } else if (!this.msTokens) {
      hints.push(
        this.pending && this.pending.expiresAt > Date.now()
          ? `Enter code ${this.pending.userCode} at ${this.pending.verificationUri}, sign in with the account your Xbox uses, then press Complete.`
          : 'Press Pair to sign in with Microsoft for cloud power on/off.',
      );
    }
    return hints.length > 0 ? hints.join(' ') : undefined;
  }

  commands(): CommandSpec[] {
    return [
      {
        name: 'power',
        label: 'Power',
        group: 'power',
        params: [{ name: 'on', type: 'boolean', required: true, default: true }],
      },
      { name: 'wake', label: 'Wake console', group: 'power' },
      { name: 'off', label: 'Turn off', group: 'power' },
    ];
  }

  async refresh(): Promise<Omit<DeviceState, 'online' | 'updatedAt'>> {
    const targets = this.probeTargets();
    const packet = discoveryRequest();
    const cloud = {
      cloudPaired: Boolean(this.msTokens),
      pendingPin: this.pending && this.pending.expiresAt > Date.now() ? this.pending.userCode : null,
    };

    for (const host of targets) {
      const replies = await this.ctx.transport.udp({ host, port: SMARTGLASS_PORT }, packet, {
        broadcast: host.endsWith('.255') || host === '255.255.255.255',
        collectMs: 900,
      });
      for (const reply of replies) {
        const parsed = parseDiscoveryResponse(reply.data);
        if (!parsed) continue;
        // Only accept a reply from our console once we know which one it is.
        if (this.cfg.host && reply.from !== this.cfg.host) continue;
        if (parsed.liveId && parsed.liveId !== this.liveId) {
          this.liveId = parsed.liveId;
          this.ctx.store.set(this.ns, 'liveId', parsed.liveId);
          this.ctx.logger.info(`learned live ID ${parsed.liveId} from discovery`);
        }
        return {
          on: true,
          consoleName: parsed.name || null,
          uuid: parsed.uuid || null,
          liveId: this.liveId ?? null,
          host: reply.from,
          canWake: this.canWake(),
          lastSeen: Date.now(),
          ...cloud,
        };
      }
    }

    // No discovery reply means standby or powered down, not an error: a
    // console in standby stops answering on 5050.
    return {
      on: false,
      consoleName: (this.ctx.store.get<string>(this.ns, 'name') ?? null) as string | null,
      liveId: this.liveId ?? null,
      host: this.cfg.host ?? null,
      canWake: this.canWake(),
      needsSetup: !this.canWake(),
      ...cloud,
    };
  }

  async execute(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    switch (command) {
      case 'wake':
        return await this.powerOn();

      case 'off':
        return await this.powerOff();

      case 'power':
        return bool(params, 'on', true) ? await this.powerOn() : await this.powerOff();

      default:
        throw new UnsupportedCommandError(command, this.type);
    }
  }

  // -- power ----------------------------------------------------------------

  private canWake(): boolean {
    return Boolean(this.liveId) || Boolean(this.msTokens);
  }

  private async powerOn(): Promise<CommandResult> {
    if (this.msTokens) {
      try {
        await this.cloudPower('WakeUp');
        return { ok: true, message: 'Wake sent through Xbox Live; the console takes a few seconds to come up' };
      } catch (err) {
        if (!this.liveId) throw err;
        this.ctx.logger.warn(`cloud wake failed, falling back to local wake: ${(err as Error).message}`);
      }
    }
    return await this.localWake();
  }

  private async powerOff(): Promise<CommandResult> {
    if (!this.msTokens) {
      throw new BadRequestError(
        'Turning the Xbox off needs the Microsoft sign-in. Set XBOX_CLIENT_ID and press Pair on the Xbox tile.',
      );
    }
    await this.cloudPower('TurnOff');
    return { ok: true, message: 'Turn-off sent through Xbox Live' };
  }

  private async localWake(): Promise<CommandResult> {
    if (!this.liveId) {
      throw new NeedsSetupError(
        'No Xbox live ID known yet. Turn the console on and refresh the device so the hub can learn it, or set `liveId` in config.',
      );
    }
    const packet = powerOnRequest(this.liveId);
    // The console frequently misses the first packet coming out of standby, so
    // the reference implementations all send a short burst.
    for (const host of this.wakeTargets()) {
      await this.ctx.transport.udp({ host, port: SMARTGLASS_PORT }, packet, {
        broadcast: host.endsWith('.255') || host === '255.255.255.255',
        repeat: 5,
        repeatDelayMs: 500,
      });
    }
    return { ok: true, message: 'Wake packet sent on the local network' };
  }

  private async cloudPower(command: 'WakeUp' | 'TurnOff'): Promise<void> {
    const consoleId = await this.resolveCloudConsoleId(false);
    const res = await this.xccs('/commands', {
      method: 'POST',
      body: JSON.stringify({
        destination: 'Xbox',
        type: 'Power',
        command,
        sessionId: randomUUID(),
        sourceId: 'com.microsoft.smartglass',
        parameters: [{}],
        linkedXboxId: consoleId,
      }),
    });
    let status: { errorCode?: string; errorMessage?: string | null } | undefined;
    try {
      status = res.json<{ status?: { errorCode?: string; errorMessage?: string | null } }>().status;
    } catch {
      status = undefined;
    }
    if (status?.errorCode && status.errorCode !== 'OK') {
      throw new Error(`Xbox Live refused ${command}: ${status.errorMessage ?? status.errorCode}`);
    }
    this.ctx.logger.info(`cloud ${command} sent to ${consoleId}`);
  }

  /**
   * The cloud addresses consoles by the same ID discovery reports, but ask the
   * account's console list rather than assume, and remember the answer.
   */
  private async resolveCloudConsoleId(force: boolean): Promise<string> {
    const cached = this.ctx.store.get<string>(this.ns, 'cloudConsoleId');
    if (cached && !force) return cached;

    const res = await this.xccs('/lists/devices?queryCurrentDevice=false&includeStorageDevices=true', {});
    const consoles = res.json<{ result?: CloudConsole[] }>().result ?? [];
    const wanted = this.liveId?.toUpperCase();
    const match = consoles.find((c) => c.id.toUpperCase() === wanted) ?? consoles[0];
    if (!match) {
      throw new Error(
        'No consoles found on this Microsoft account. Sign in with the account your Xbox uses, and enable Settings > Devices & connections > Remote features on the console.',
      );
    }
    if (wanted && match.id.toUpperCase() !== wanted) {
      const list = consoles.map((c) => `${c.name ?? '?'} (${c.id})`).join(', ');
      this.ctx.logger.warn(`live ID ${this.liveId} not on this account; using ${match.id}. Consoles: ${list}`);
    }
    this.ctx.store.set(this.ns, 'cloudConsoleId', match.id);
    return match.id;
  }

  // -- Microsoft sign-in (device code flow) ---------------------------------

  private get clientId(): string {
    const id = process.env['XBOX_CLIENT_ID'];
    if (!id) {
      throw new NeedsSetupError(
        'XBOX_CLIENT_ID is not set. Register an app in the Azure portal (personal Microsoft accounts, public client flows on) and add its client ID to /etc/pi-smart-home-hub.env.',
      );
    }
    return id;
  }

  /** Step 1: get a code for the user to enter at microsoft.com/link. */
  async pairStart(): Promise<{ pin: string; expiresInSeconds: number }> {
    const res = await this.form(`${MS_LOGIN}/devicecode`, { client_id: this.clientId, scope: MS_SCOPE });
    const body = res.json<{
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      error_description?: string;
    }>();
    if (!res.ok || !body.device_code || !body.user_code) {
      throw new Error(
        body.error_description ??
          `Microsoft did not return a sign-in code (HTTP ${res.status}). Check XBOX_CLIENT_ID and that public client flows are enabled.`,
      );
    }
    const expiresInSeconds = body.expires_in ?? 900;
    this.pending = {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri ?? 'https://www.microsoft.com/link',
      expiresAt: Date.now() + expiresInSeconds * 1000,
    };
    this.ctx.store.set(this.ns, 'pending', this.pending);
    this.ctx.logger.info(`sign in at ${this.pending.verificationUri} with code ${this.pending.userCode}`);
    return { pin: body.user_code, expiresInSeconds };
  }

  /** Step 2: once the code has been entered and approved, claim tokens. */
  async pairComplete(): Promise<void> {
    const pending = this.pending ?? this.ctx.store.get<PendingSignIn>(this.ns, 'pending');
    if (!pending) throw new Error('No sign-in in progress. Press Pair first.');
    if (pending.expiresAt < Date.now()) throw new Error('That code has expired. Press Pair for a new one.');

    const res = await this.form(`${MS_LOGIN}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: this.clientId,
      device_code: pending.deviceCode,
    });
    const body = res.json<MsTokenBody>();
    if (!res.ok || !body.access_token || !body.refresh_token) {
      if (body.error === 'authorization_pending') {
        throw new Error(
          `Microsoft has not seen the code yet. Enter ${pending.userCode} at ${pending.verificationUri}, then press Complete.`,
        );
      }
      throw new Error(body.error_description ?? `Microsoft sign-in failed with HTTP ${res.status}`);
    }

    this.saveMsTokens(body.access_token, body.refresh_token, body.expires_in ?? 3600);
    this.pending = undefined;
    this.ctx.store.delete(this.ns, 'pending');
    // Prove the whole chain works now rather than at the first wake.
    const consoleId = await this.resolveCloudConsoleId(true);
    this.ctx.logger.info(`signed in to Xbox Live; console ${consoleId}`);
  }

  private saveMsTokens(accessToken: string, refreshToken: string, expiresIn: number): void {
    this.msTokens = { accessToken, refreshToken, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
    this.xbl = undefined;
    this.ctx.store.set(this.ns, 'msTokens', this.msTokens);
    void this.ctx.store.flush();
  }

  private async ensureMsToken(): Promise<string> {
    const tokens = this.msTokens;
    if (!tokens) throw new NeedsSetupError('Not signed in to Microsoft. Press Pair on the Xbox tile.');
    if (tokens.expiresAt > Date.now()) return tokens.accessToken;
    // Collapse concurrent refreshes; Microsoft rotates the refresh token.
    if (!this.refreshing) {
      this.refreshing = this.refreshMsToken().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    if (!this.msTokens) throw new NeedsSetupError('Microsoft sign-in expired. Press Pair to sign in again.');
    return this.msTokens.accessToken;
  }

  private async refreshMsToken(): Promise<void> {
    const tokens = this.msTokens;
    if (!tokens) throw new NeedsSetupError('Not signed in to Microsoft. Press Pair on the Xbox tile.');
    const res = await this.form(`${MS_LOGIN}/token`, {
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: tokens.refreshToken,
      scope: MS_SCOPE,
    });
    const body = res.json<MsTokenBody>();
    if (!res.ok || !body.access_token) {
      if (res.status === 400 || res.status === 401) {
        this.msTokens = undefined;
        this.ctx.store.delete(this.ns, 'msTokens');
        throw new NeedsSetupError('Microsoft sign-in was revoked or expired. Press Pair to sign in again.');
      }
      throw new Error(`Microsoft token refresh failed with HTTP ${res.status}`);
    }
    this.saveMsTokens(body.access_token, body.refresh_token ?? tokens.refreshToken, body.expires_in ?? 3600);
    this.ctx.logger.debug('Microsoft access token refreshed');
  }

  private async form(url: string, fields: Record<string, string>) {
    return await this.ctx.transport.http(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
      timeoutMs: 10_000,
      allowStatus: true,
    });
  }

  // -- Xbox Live tokens and console service ---------------------------------

  /** Microsoft token -> Xbox user token -> XSTS token, cached until expiry. */
  private async xblAuthHeader(): Promise<string> {
    if (this.xbl && this.xbl.expiresAt > Date.now()) return this.xbl.header;

    const accessToken = await this.ensureMsToken();
    const user = await this.xblPost(XBL_USER_AUTH, {
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${accessToken}` },
    });
    if (!user.Token) throw new Error('Xbox Live did not accept the Microsoft token');

    const xsts = await this.xblPost(XBL_XSTS, {
      RelyingParty: 'http://xboxlive.com',
      TokenType: 'JWT',
      Properties: { SandboxId: 'RETAIL', UserTokens: [user.Token] },
    });
    const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;
    if (!xsts.Token || !uhs) throw new Error('Xbox Live did not return an XSTS token');

    const notAfter = xsts.NotAfter ? Date.parse(xsts.NotAfter) : Number.NaN;
    const expiresAt = Number.isFinite(notAfter) ? notAfter - 5 * 60_000 : Date.now() + 60 * 60_000;
    this.xbl = { header: `XBL3.0 x=${uhs};${xsts.Token}`, expiresAt };
    return this.xbl.header;
  }

  private async xblPost(url: string, payload: Record<string, unknown>): Promise<XblTokenResponse> {
    const res = await this.ctx.transport.http(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-xbl-contract-version': '1',
      },
      body: JSON.stringify(payload),
      timeoutMs: 10_000,
      allowStatus: true,
    });
    if (res.ok) return res.json<XblTokenResponse>();

    let xerr: number | undefined;
    try {
      xerr = res.json<XblTokenResponse>().XErr;
    } catch {
      xerr = undefined;
    }
    if (xerr === XERR_NO_XBOX_PROFILE) {
      throw new Error('This Microsoft account has no Xbox profile. Sign in with the account your console uses.');
    }
    if (xerr === XERR_CHILD_ACCOUNT) {
      throw new Error('This is a child account; an adult must allow it in Microsoft Family before other apps can use it.');
    }
    throw new Error(`Xbox Live sign-in failed with HTTP ${res.status}${xerr ? ` (XErr ${xerr})` : ''}`);
  }

  private async xccs(path: string, init: { method?: 'GET' | 'POST'; body?: string }) {
    const send = async (auth: string) =>
      await this.ctx.transport.http(`${XCCS}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: auth,
          'x-xbl-contract-version': '4',
          skillplatform: 'RemoteManagement',
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        timeoutMs: 10_000,
        allowStatus: true,
      });

    let res = await send(await this.xblAuthHeader());
    if (res.status === 401 || res.status === 403) {
      // XSTS token died early; rebuild the chain once and retry.
      this.xbl = undefined;
      res = await send(await this.xblAuthHeader());
    }
    if (!res.ok) throw new Error(`Xbox Live console service returned HTTP ${res.status}`);
    return res;
  }

  // -- local targets --------------------------------------------------------

  private probeTargets(): string[] {
    const targets: string[] = [];
    if (this.cfg.host) targets.push(this.cfg.host);
    const broadcast = this.cfg.broadcastAddress;
    if (broadcast) targets.push(broadcast);
    if (targets.length === 0) targets.push('255.255.255.255');
    return targets;
  }

  private wakeTargets(): string[] {
    const targets = new Set<string>(this.probeTargets());
    targets.add('255.255.255.255');
    return [...targets];
  }
}
