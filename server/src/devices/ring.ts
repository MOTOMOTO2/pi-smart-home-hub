import { randomUUID } from 'node:crypto';
import type { DeviceConfig } from '../config.js';
import {
  DeviceAdapter,
  NeedsSetupError,
  UnsupportedCommandError,
  bool,
  str,
  type Capability,
  type CommandResult,
  type CommandSpec,
  type DeviceContext,
  type DeviceState,
} from './types.js';

type RingConfig = Extract<DeviceConfig, { type: 'ring' }>;

const OAUTH = 'https://oauth.ring.com/oauth/token';
const API = 'https://api.ring.com';
const CLIENT_ID = 'ring_official_android';
const USER_AGENT = 'android:com.ringapp';

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface RingDevice {
  id: number;
  description?: string;
  kind?: string;
  battery_life?: string | number | null;
  firmware_version?: string;
  led_status?: string;
  siren_status?: { seconds_remaining?: number };
  health?: { battery_percentage?: number };
}

interface RingDevicesResponse {
  doorbots?: RingDevice[];
  authorized_doorbots?: RingDevice[];
  stickup_cams?: RingDevice[];
  chimes?: RingDevice[];
  other?: RingDevice[];
}

interface RingHistoryItem {
  id: number | string;
  created_at: string;
  kind: string;
  answered?: boolean;
  duration?: number;
  recording?: { status?: string };
}

interface RingActiveDing {
  id_str?: string;
  id?: number | string;
  doorbot_id?: number;
  kind?: string;
  expires_in?: number;
}

/**
 * Ring doorbell. Ring publishes no public API, so this speaks the same
 * endpoints the mobile app uses: an OAuth password grant (with 2FA) exchanged
 * once for a long-lived refresh token, then the `clients_api` REST surface for
 * device health, event history and snapshots.
 *
 * Scope is deliberately "status and stills": battery/wifi health, the motion
 * and doorbell event feed (which drives hub automations), on-demand snapshots,
 * and floodlight/siren control on cameras that have them. Live video is WebRTC
 * and belongs in the Ring app, not in a Pi dashboard.
 *
 * Only the refresh token is stored -- never the password. Note that Ring
 * invalidates a refresh token once it is used, so the newest one is persisted
 * on every refresh.
 */
export class RingAdapter extends DeviceAdapter {
  readonly type = 'ring';
  readonly icon = 'doorbell';
  readonly capabilities: Capability[] = ['camera', 'events', 'sensors'];

  private tokens: TokenSet | undefined;
  private hardwareId = '';
  private pendingLogin: { username: string; password: string; phone?: string } | undefined;
  private deviceId: number | undefined;
  private lastEventId: string | undefined;
  private refreshing: Promise<void> | null = null;

  constructor(ctx: DeviceContext, private readonly cfg: RingConfig) {
    super(ctx);
    this.pollIntervalMs = cfg.pollSeconds * 1000;
  }

  override async init(): Promise<void> {
    const ns = `ring:${this.id}`;
    let hardwareId = this.ctx.store.get<string>(ns, 'hardwareId');
    if (!hardwareId) {
      // Ring ties sessions to this value; a stable one avoids re-triggering 2FA.
      hardwareId = randomUUID();
      this.ctx.store.set(ns, 'hardwareId', hardwareId);
    }
    this.hardwareId = hardwareId;

    const saved = this.ctx.store.get<TokenSet>(ns, 'tokens');
    const configured = this.cfg.refreshToken;
    if (saved?.refreshToken) {
      this.tokens = saved;
    } else if (configured) {
      this.tokens = { accessToken: '', refreshToken: configured, expiresAt: 0 };
    }
    this.lastEventId = this.ctx.store.get<string>(ns, 'lastEventId');
    const storedDeviceId = this.cfg.deviceId ?? this.ctx.store.get<number>(ns, 'deviceId');
    if (storedDeviceId !== undefined) this.deviceId = Number(storedDeviceId);
  }

  override setupHint(): string | undefined {
    if (!this.tokens) {
      return 'Press Pair and sign in with your Ring account. Only the resulting refresh token is stored; a verification code will be texted or emailed to you.';
    }
    return undefined;
  }

  commands(): CommandSpec[] {
    return [
      { name: 'snapshot', label: 'New snapshot', group: 'camera' },
      {
        name: 'light',
        label: 'Floodlight',
        group: 'camera',
        params: [{ name: 'on', type: 'boolean', required: true }],
      },
      {
        name: 'siren',
        label: 'Siren',
        group: 'camera',
        params: [{ name: 'on', type: 'boolean', required: true }],
      },
    ];
  }

  // -- pairing --------------------------------------------------------------

  /**
   * Returns `{ paired: true }` when the account has no 2FA, otherwise
   * `{ needsCode: true }` and Ring sends a verification code.
   */
  async pairStart(username: string, password: string): Promise<{ paired: boolean; needsCode: boolean; hint?: string }> {
    const res = await this.oauth({ grant_type: 'password', username, password, scope: 'client' });
    if (res.status === 412 || res.status === 400) {
      const body = res.json<{ phone?: string; tsv_state?: string; next_time_in_secs?: number; error?: string }>();
      if (res.status === 400 && body.error && body.error !== 'Verification Code is required') {
        throw new Error(`Ring rejected the sign-in: ${body.error}`);
      }
      this.pendingLogin = { username, password, ...(body.phone ? { phone: body.phone } : {}) };
      const where = body.tsv_state === 'sms' ? `SMS to ${body.phone ?? 'your phone'}` : 'email';
      return { paired: false, needsCode: true, hint: `Ring sent a verification code by ${where}.` };
    }
    if (!res.ok) throw new Error(`Ring sign-in failed with HTTP ${res.status}`);
    this.acceptTokens(res.json());
    return { paired: true, needsCode: false };
  }

  /** Second leg of 2FA: resend the password grant with the code attached. */
  async pairVerify(code: string): Promise<void> {
    const pending = this.pendingLogin;
    if (!pending) throw new Error('No Ring sign-in in progress. Start again.');
    const res = await this.oauth(
      { grant_type: 'password', username: pending.username, password: pending.password, scope: 'client' },
      code,
    );
    if (!res.ok) {
      const body = res.json<{ error?: string; error_description?: string }>();
      throw new Error(body?.error_description ?? body?.error ?? `Ring rejected the code (HTTP ${res.status})`);
    }
    this.acceptTokens(res.json());
    // Drop the password from memory as soon as it is no longer needed.
    this.pendingLogin = undefined;
  }

  private async oauth(payload: Record<string, string>, twoFactorCode?: string) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      hardware_id: this.hardwareId,
      '2fa-support': 'true',
    };
    if (twoFactorCode) headers['2fa-code'] = twoFactorCode;
    return await this.ctx.transport.http(OAUTH, {
      method: 'POST',
      headers,
      body: JSON.stringify({ client_id: CLIENT_ID, ...payload }),
      timeoutMs: 15_000,
      allowStatus: true,
    });
  }

  private acceptTokens(body: { access_token?: string; refresh_token?: string; expires_in?: number }): void {
    if (!body.access_token || !body.refresh_token) throw new Error('Ring response did not include tokens');
    this.tokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + ((body.expires_in ?? 3600) - 120) * 1000,
    };
    this.ctx.store.set(`ring:${this.id}`, 'tokens', this.tokens);
    void this.ctx.store.flush();
  }

  private async ensureToken(): Promise<string> {
    const tokens = this.tokens;
    if (!tokens) throw new NeedsSetupError('Ring is not paired yet.');
    if (tokens.accessToken && tokens.expiresAt > Date.now()) return tokens.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.doRefreshToken().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    if (!this.tokens?.accessToken) throw new NeedsSetupError('Ring token refresh failed; pair again.');
    return this.tokens.accessToken;
  }

  private async doRefreshToken(): Promise<void> {
    const tokens = this.tokens;
    if (!tokens) throw new NeedsSetupError('Ring is not paired yet.');
    const res = await this.oauth({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403 || res.status === 400) {
        this.tokens = undefined;
        this.ctx.store.delete(`ring:${this.id}`, 'tokens');
        throw new NeedsSetupError('Ring refresh token was rejected; sign in again.');
      }
      throw new Error(`Ring token refresh failed with HTTP ${res.status}`);
    }
    this.acceptTokens(res.json());
    this.ctx.logger.debug('access token refreshed');
  }

  private async authed(pathname: string, init: { method?: 'GET' | 'POST' | 'PUT'; body?: string } = {}) {
    const token = await this.ensureToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'user-agent': USER_AGENT,
      hardware_id: this.hardwareId,
    };
    if (init.body) headers['content-type'] = 'application/json';
    const res = await this.ctx.transport.http(`${API}${pathname}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      timeoutMs: 15_000,
      allowStatus: true,
    });
    if (res.status === 401) {
      await this.doRefreshToken();
      const retry = await this.ensureToken();
      return await this.ctx.transport.http(`${API}${pathname}`, {
        method: init.method ?? 'GET',
        headers: { ...headers, authorization: `Bearer ${retry}` },
        ...(init.body === undefined ? {} : { body: init.body }),
        timeoutMs: 15_000,
      });
    }
    if (res.status === 429) throw new Error('Ring is rate-limiting the hub; increase pollSeconds for this device');
    if (!res.ok) throw new Error(`Ring API returned HTTP ${res.status} for ${pathname}`);
    return res;
  }

  // -- state ----------------------------------------------------------------

  async refresh(): Promise<Omit<DeviceState, 'online' | 'updatedAt'>> {
    if (!this.tokens) return { needsSetup: true, paired: false, awaitingCode: Boolean(this.pendingLogin) };

    const device = await this.resolveDevice();
    const [healthRes, historyRes, dingsRes] = await Promise.all([
      this.authed(`/clients_api/doorbots/${device.id}/health`),
      this.authed('/clients_api/doorbots/history?limit=12'),
      this.authed('/clients_api/dings/active'),
    ]);

    const health = healthRes.json<{
      device_health?: {
        battery_percentage?: number | string;
        latest_signal_strength?: number;
        latest_signal_category?: string;
        firmware?: string;
        wifi_name?: string;
challenge?: unknown;
      };
    }>().device_health;

    const history = historyRes.json<RingHistoryItem[]>() ?? [];
    const mine = history.filter((item) => item && item.id !== undefined);
    const events = mine.slice(0, 12).map((item) => ({
      id: String(item.id),
      kind: item.kind,
      at: item.created_at,
      answered: item.answered ?? false,
      durationSeconds: item.duration ?? null,
      hasRecording: item.recording?.status === 'ready',
    }));

    const active = (dingsRes.json<RingActiveDing[]>() ?? []).filter(
      (ding) => ding.doorbot_id === undefined || ding.doorbot_id === device.id,
    );

    this.emitNewEvents(events, active);

    const battery = Number(health?.battery_percentage ?? device.battery_life ?? NaN);
    return {
      paired: true,
      on: true,
      deviceId: device.id,
      deviceName: device.description ?? this.name,
      kind: device.kind ?? null,
      battery: Number.isFinite(battery) ? battery : null,
      signalStrength: health?.latest_signal_strength ?? null,
      signalCategory: health?.latest_signal_category ?? null,
      wifiName: health?.wifi_name ?? null,
      firmware: health?.firmware ?? device.firmware_version ?? null,
      ringing: active.some((d) => d.kind === 'ding'),
      motionActive: active.some((d) => d.kind === 'motion'),
      activeDings: active.length,
      lastEvent: events[0] ?? null,
      events,
      hasLight: device.led_status !== undefined,
      hasSiren: device.siren_status !== undefined,
      snapshotUrl: `/api/devices/${this.id}/snapshot`,
    };
  }

  /**
   * Turn newly seen history entries and active dings into hub events so
   * automations can react ("flash the lights when someone rings").
   */
  private emitNewEvents(
    events: Array<{ id: string; kind: string; at: string }>,
    active: RingActiveDing[],
  ): void {
    const newest = events[0];
    if (newest && newest.id !== this.lastEventId) {
      const previous = this.lastEventId;
      this.lastEventId = newest.id;
      this.ctx.store.set(`ring:${this.id}`, 'lastEventId', newest.id);
      // On the very first poll we only record the cursor: replaying yesterday
      // on a hub restart would be worse than missing one event.
      if (previous !== undefined) {
        const unseen = [];
        for (const event of events) {
          if (event.id === previous) break;
          unseen.push(event);
        }
        for (const event of unseen.reverse()) {
          const name = event.kind === 'ding' ? 'ring.ding' : event.kind === 'motion' ? 'ring.motion' : 'ring.event';
          this.ctx.emit(name, { deviceId: this.id, eventId: event.id, kind: event.kind, at: event.at });
        }
      }
    }
    for (const ding of active) {
      if (ding.kind !== 'ding') continue;
      const key = ding.id_str ?? String(ding.id ?? '');
      const seen = this.ctx.store.get<string>(`ring:${this.id}`, 'lastActiveDing');
      if (key && key !== seen) {
        this.ctx.store.set(`ring:${this.id}`, 'lastActiveDing', key);
        this.ctx.emit('ring.ding', { deviceId: this.id, eventId: key, kind: 'ding', live: true });
      }
    }
  }

  private async resolveDevice(): Promise<RingDevice> {
    const cached = this.ctx.store.get<RingDevice>(`ring:${this.id}`, 'device');
    if (this.deviceId && cached && cached.id === this.deviceId) return cached;

    const res = await this.authed('/clients_api/ring_devices');
    const body = res.json<RingDevicesResponse>();
    const all = [
      ...(body.doorbots ?? []),
      ...(body.authorized_doorbots ?? []),
      ...(body.stickup_cams ?? []),
      ...(body.other ?? []),
    ];
    if (all.length === 0) throw new Error('No Ring doorbells or cameras on this account');
    const chosen = this.deviceId ? all.find((d) => d.id === this.deviceId) : all[0];
    if (!chosen) {
      throw new Error(
        `Ring device ${this.deviceId} not found. Available: ${all.map((d) => `${d.id} (${d.description ?? d.kind})`).join(', ')}`,
      );
    }
    this.deviceId = chosen.id;
    this.ctx.store.set(`ring:${this.id}`, 'deviceId', chosen.id);
    this.ctx.store.set(`ring:${this.id}`, 'device', chosen);
    return chosen;
  }

  async execute(command: string, params: Record<string, unknown>): Promise<CommandResult> {
    const device = await this.resolveDevice();
    switch (command) {
      case 'snapshot': {
        await this.authed('/clients_api/snapshots/update_all', {
          method: 'POST',
          body: JSON.stringify({ doorbot_ids: [device.id], refresh: true }),
        });
        return { ok: true, message: 'Snapshot requested' };
      }

      case 'light': {
        const on = bool(params, 'on');
        await this.authed(`/clients_api/doorbots/${device.id}/floodlight_light_${on ? 'on' : 'off'}`, {
          method: 'PUT',
        });
        return { ok: true, message: on ? 'Light on' : 'Light off' };
      }

      case 'siren': {
        const on = bool(params, 'on');
        await this.authed(`/clients_api/doorbots/${device.id}/siren_${on ? 'on' : 'off'}`, { method: 'PUT' });
        return { ok: true, message: on ? 'Siren on' : 'Siren off' };
      }

      case 'playback': {
        const eventId = str(params, 'eventId');
        const res = await this.authed(`/clients_api/dings/${encodeURIComponent(eventId)}/share/play?disable_redirect=true`);
        const body = res.json<{ url?: string }>();
        if (!body.url) throw new Error('Ring did not return a recording URL for that event');
        return { ok: true, data: { url: body.url } };
      }

      default:
        throw new UnsupportedCommandError(command, this.type);
    }
  }

  override async snapshot(): Promise<{ contentType: string; body: Buffer }> {
    const device = await this.resolveDevice();
    const res = await this.authed(`/clients_api/snapshots/image/${device.id}`);
    return { contentType: res.headers['content-type'] ?? 'image/jpeg', body: res.body };
  }
}
