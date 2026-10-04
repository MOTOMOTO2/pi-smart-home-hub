import type { DeviceConfig } from '../config.js';
import { AndroidTvAdapter } from './androidtv.js';
import { EcobeeAdapter } from './ecobee.js';
import { NanoleafAdapter } from './nanoleaf.js';
import { PcAdapter } from './pc.js';
import { RingAdapter } from './ring.js';
import { RokuTvAdapter } from './rokutv.js';
import { XboxAdapter } from './xbox.js';
import type { DeviceAdapter, DeviceContext } from './types.js';

export const DEVICE_TYPES = ['nanoleaf', 'rokutv', 'androidtv', 'xbox', 'pc', 'ecobee', 'ring'] as const;

export function createAdapter(cfg: DeviceConfig, ctx: DeviceContext): DeviceAdapter {
  switch (cfg.type) {
    case 'nanoleaf':
      return new NanoleafAdapter(ctx, cfg);
    case 'rokutv':
      return new RokuTvAdapter(ctx, cfg);
    case 'androidtv':
      return new AndroidTvAdapter(ctx, cfg);
    case 'xbox':
      return new XboxAdapter(ctx, cfg);
    case 'pc':
      return new PcAdapter(ctx, cfg);
    case 'ecobee':
      return new EcobeeAdapter(ctx, cfg);
    case 'ring':
      return new RingAdapter(ctx, cfg);
    default: {
      // Exhaustiveness guard: adding a config variant without an adapter fails here.
      const unknown: never = cfg;
      throw new Error(`no adapter for device type ${JSON.stringify(unknown)}`);
    }
  }
}
