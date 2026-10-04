import { useState } from 'react';
import { api } from '../lib/api';
import type { HubStore } from '../lib/useHub';
import { Icon } from '../components/Icon';
import { Button, Empty, relativeTime } from '../components/controls';

const EVENT_ICONS: Record<string, string> = {
  'ring.ding': 'bell',
  'ring.motion': 'activity',
  'ring.event': 'activity',
  'scene.run': 'wand',
  'device.command': 'link',
};

export function ActivityView({ store }: { store: HubStore }): JSX.Element {
  const [tab, setTab] = useState<'events' | 'logs'>('events');
  const isDemo = store.hub?.demo === true;

  return (
    <div className="activity-view">
      <header className="view-head">
        <div className="chips">
          <button type="button" className="chip" data-active={tab === 'events'} onClick={() => setTab('events')}>
            Events
          </button>
          <button type="button" className="chip" data-active={tab === 'logs'} onClick={() => setTab('logs')}>
            Logs
          </button>
        </div>
        {isDemo ? (
          <div className="button-row">
            <Button
              icon="bell"
              onClick={async () => {
                try {
                  await api.demoDoorbell('ding');
                  store.notify('ok', 'Simulated doorbell press');
                } catch (err) {
                  store.notify('error', err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Ring the demo doorbell
            </Button>
            <Button
              icon="activity"
              onClick={async () => {
                try {
                  await api.demoDoorbell('motion');
                  store.notify('ok', 'Simulated motion');
                } catch (err) {
                  store.notify('error', err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Simulate motion
            </Button>
          </div>
        ) : null}
      </header>

      {tab === 'events' ? (
        store.events.length === 0 ? (
          <Empty icon="activity">
            Nothing has happened yet. Doorbell presses, motion, scene runs and device commands land here.
          </Empty>
        ) : (
          <ul className="feed">
            {store.events.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <Icon name={EVENT_ICONS[event.name] ?? 'activity'} size={16} />
                <span className="feed-name">{event.name}</span>
                <span className="feed-detail">{describePayload(event.payload)}</span>
                <time>{relativeTime(event.at)}</time>
              </li>
            ))}
          </ul>
        )
      ) : store.logs.length === 0 ? (
        <Empty icon="info">No log lines buffered yet.</Empty>
      ) : (
        <ul className="feed logs">
          {store.logs.map((record, index) => (
            <li key={`${record.ts}-${index}`} data-level={record.level}>
              <span className="log-level">{record.level}</span>
              <span className="log-scope">{record.scope}</span>
              <span className="log-message">{record.message}</span>
              <time>{new Date(record.ts).toLocaleTimeString()}</time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describePayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || typeof value === 'object') continue;
    if (key === 'params') continue;
    parts.push(`${key}=${String(value)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(' ');
}
