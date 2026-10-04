import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'ids may contain letters, numbers, dashes and underscores');

const baseDevice = {
  id,
  name: z.string().min(1),
  room: z.string().optional(),
  enabled: z.boolean().default(true),
  /** Poll interval in seconds; adapters pick a sensible default when omitted. */
  pollSeconds: z.number().int().min(2).max(3600).optional(),
};

const nanoleafDevice = z.object({
  ...baseDevice,
  type: z.literal('nanoleaf'),
  host: z.string().min(1),
  port: z.number().int().default(16021),
  /** Usually left out: pair from the UI and the token lands in data/state.json. */
  token: z.string().optional(),
});

const rokuTvDevice = z.object({
  ...baseDevice,
  type: z.literal('rokutv'),
  host: z.string().min(1),
  port: z.number().int().default(8060),
  /** TCL Roku TVs only answer power-on over the network with Fast TV Start on. */
  mac: z.string().optional(),
});

const androidTvDevice = z.object({
  ...baseDevice,
  type: z.literal('androidtv'),
  host: z.string().min(1),
  adbPort: z.number().int().default(5555),
  adbPath: z.string().default('adb'),
  mac: z.string().optional(),
});

const xboxDevice = z.object({
  ...baseDevice,
  type: z.literal('xbox'),
  host: z.string().optional(),
  /** 16 hex characters from the console certificate; auto-learned on discovery. */
  liveId: z.string().optional(),
  broadcastAddress: z.string().optional(),
});

const pcDevice = z.object({
  ...baseDevice,
  type: z.literal('pc'),
  mac: z.string().optional(),
  host: z.string().optional(),
  broadcastAddress: z.string().optional(),
  /** Optional companion agent (agents/pc-agent) for sleep/shutdown/lock. */
  agentUrl: z.string().optional(),
  agentToken: z.string().optional(),
  /** TCP port used to decide whether the PC is up when there is no agent. */
  probePort: z.number().int().default(3389),
});

const ecobeeDevice = z.object({
  ...baseDevice,
  type: z.literal('ecobee'),
  apiKey: z.string().optional(),
  /** Seed a token you already have; normally earned via the PIN flow instead. */
  refreshToken: z.string().optional(),
  /** Restrict to one thermostat by identifier; defaults to the first one. */
  thermostatId: z.string().optional(),
  scale: z.enum(['F', 'C']).default('F'),
});

const ringDevice = z.object({
  ...baseDevice,
  type: z.literal('ring'),
  /** Numeric doorbot id; defaults to the first doorbell on the account. */
  deviceId: z.union([z.string(), z.number()]).optional(),
  refreshToken: z.string().optional(),
  /** Ring rate-limits hard, so do not poll it like a lightbulb. */
  pollSeconds: z.number().int().min(10).max(3600).default(45),
});

export const deviceSchema = z.discriminatedUnion('type', [
  nanoleafDevice,
  rokuTvDevice,
  androidTvDevice,
  xboxDevice,
  pcDevice,
  ecobeeDevice,
  ringDevice,
]);

export type DeviceConfig = z.infer<typeof deviceSchema>;
export type DeviceType = DeviceConfig['type'];

const sceneAction = z
  .object({
    device: z.string().optional(),
    command: z.string().optional(),
    params: z.record(z.unknown()).default({}),
    /** Pause before running the next action. */
    delayMs: z.number().int().min(0).max(600_000).optional(),
  })
  .refine((a) => (a.device && a.command) || a.delayMs !== undefined, {
    message: 'a scene action needs either device+command or delayMs',
  });

export type SceneAction = z.infer<typeof sceneAction>;

export const sceneSchema = z.object({
  id,
  name: z.string().min(1),
  icon: z.string().default('*'),
  /** Show on the dashboard quick-bar. */
  favorite: z.boolean().default(false),
  actions: z.array(sceneAction).min(1),
});

export type SceneConfig = z.infer<typeof sceneSchema>;

const triggerSchema = z.union([
  z.object({
    event: z.string().min(1),
    device: z.string().optional(),
  }),
  z.object({
    schedule: z.string().min(1),
  }),
  z.object({
    deviceState: z.object({
      device: z.string().min(1),
      path: z.string().min(1),
      equals: z.unknown().optional(),
      above: z.number().optional(),
      below: z.number().optional(),
    }),
  }),
]);

export type AutomationTrigger = z.infer<typeof triggerSchema>;

export const automationSchema = z.object({
  id,
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  when: triggerSchema,
  /** Ignore repeat triggers inside this window. */
  cooldownSeconds: z.number().int().min(0).max(86_400).default(0),
  /** Only run between these wall-clock times, e.g. "22:00" to "06:30". */
  between: z
    .object({
      from: z.string().regex(/^\d{1,2}:\d{2}$/),
      to: z.string().regex(/^\d{1,2}:\d{2}$/),
    })
    .optional(),
  run: z.array(sceneAction).optional(),
  scene: z.string().optional(),
});

export type AutomationConfig = z.infer<typeof automationSchema>;

export const configSchema = z.object({
  server: z
    .object({
      host: z.string().default('0.0.0.0'),
      port: z.number().int().min(1).max(65535).default(8080),
    })
    .default({}),
  auth: z
    .object({
      /** When set, every API call needs this bearer token (or ?token=). */
      token: z.string().optional(),
    })
    .default({}),
  /**
   * Demo mode swaps the network transport for in-process device simulators.
   * The adapters themselves are unchanged, so the dashboard is fully usable
   * with no hardware on the bench.
   */
  demo: z.boolean().default(false),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  dataDir: z.string().default('data'),
  network: z
    .object({
      /** Directed broadcast for WoL / Xbox power-on, e.g. 192.168.1.255. */
      broadcastAddress: z.string().optional(),
    })
    .default({}),
  devices: z.array(deviceSchema).default([]),
  scenes: z.array(sceneSchema).default([]),
  automations: z.array(automationSchema).default([]),
});

export type HubConfig = z.infer<typeof configSchema>;

export interface LoadedConfig {
  config: HubConfig;
  /** Absolute path of the file that was read, or null for built-in defaults. */
  source: string | null;
  usedFallback: boolean;
}

const ENV_PREFIX = 'HUB_';

/**
 * Secrets should not sit in a YAML file that gets committed, so any string
 * value may be written as `${ENV_VAR}` and is substituted from the
 * environment at load time.
 */
export function expandEnv(input: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof input === 'string') {
    return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
      const value = env[name];
      if (value !== undefined && value !== '') return value;
      return fallback ?? '';
    });
  }
  if (Array.isArray(input)) return input.map((v) => expandEnv(v, env));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = expandEnv(v, env);
    return out;
  }
  return input;
}

/** `HUB_PORT`, `HUB_HOST`, `HUB_TOKEN`, `HUB_DEMO`, `HUB_LOG_LEVEL`. */
function applyEnvOverrides(config: HubConfig, env: NodeJS.ProcessEnv): HubConfig {
  const port = env[`${ENV_PREFIX}PORT`];
  if (port && Number.isInteger(Number(port))) config.server.port = Number(port);
  const host = env[`${ENV_PREFIX}HOST`];
  if (host) config.server.host = host;
  const token = env[`${ENV_PREFIX}TOKEN`];
  if (token) config.auth.token = token;
  const demo = env[`${ENV_PREFIX}DEMO`];
  if (demo !== undefined && demo !== '') config.demo = ['1', 'true', 'yes', 'on'].includes(demo.toLowerCase());
  const level = env[`${ENV_PREFIX}LOG_LEVEL`];
  if (level && ['debug', 'info', 'warn', 'error'].includes(level)) config.logLevel = level as HubConfig['logLevel'];
  const dataDir = env[`${ENV_PREFIX}DATA_DIR`];
  if (dataDir) config.dataDir = dataDir;
  return config;
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): HubConfig {
  const parsed = configSchema.parse(expandEnv(raw, env));
  const seen = new Set<string>();
  for (const device of parsed.devices) {
    if (seen.has(device.id)) throw new Error(`duplicate device id "${device.id}"`);
    seen.add(device.id);
  }
  const sceneIds = new Set<string>();
  for (const scene of parsed.scenes) {
    if (sceneIds.has(scene.id)) throw new Error(`duplicate scene id "${scene.id}"`);
    sceneIds.add(scene.id);
  }
  for (const scene of parsed.scenes) {
    for (const action of scene.actions) {
      if (action.device && !seen.has(action.device)) {
        throw new Error(`scene "${scene.id}" references unknown device "${action.device}"`);
      }
    }
  }
  for (const automation of parsed.automations) {
    if (automation.scene && !sceneIds.has(automation.scene)) {
      throw new Error(`automation "${automation.id}" references unknown scene "${automation.scene}"`);
    }
    if (!automation.scene && (!automation.run || automation.run.length === 0)) {
      throw new Error(`automation "${automation.id}" needs either "scene" or "run"`);
    }
    for (const action of automation.run ?? []) {
      if (action.device && !seen.has(action.device)) {
        throw new Error(`automation "${automation.id}" references unknown device "${action.device}"`);
      }
    }
  }
  return applyEnvOverrides(parsed, env);
}

export function candidateConfigPaths(rootDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env[`${ENV_PREFIX}CONFIG`];
  const paths = explicit ? [path.resolve(rootDir, explicit)] : [];
  return [
    ...paths,
    path.join(rootDir, 'config', 'hub.yaml'),
    path.join(rootDir, 'config', 'hub.yml'),
    path.join(rootDir, 'config', 'demo.yaml'),
  ];
}

export function loadConfig(rootDir: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const candidates = candidateConfigPaths(rootDir, env);
  for (const [index, file] of candidates.entries()) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const raw = yaml.load(text) ?? {};
    return {
      config: parseConfig(raw, env),
      source: file,
      // The last candidate is the bundled demo profile.
      usedFallback: index === candidates.length - 1,
    };
  }
  return { config: parseConfig({}, env), source: null, usedFallback: true };
}

export function describeValidationError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((issue) => `  - ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('\n');
  }
  return err instanceof Error ? err.message : String(err);
}
