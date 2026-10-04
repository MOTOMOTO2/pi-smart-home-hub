import { useState } from 'react';
import { api } from '../lib/api';
import { Button, Field, Modal } from './controls';
import type { Device } from '../lib/types';

/**
 * Pairing differs per vendor, so this walks whichever flow the device needs:
 * a single button for Nanoleaf (physical button press), a PIN round-trip for
 * Ecobee, and an email/password plus 2FA code for Ring.
 */
export function PairDialog({
  device,
  onClose,
  onDone,
  notify,
}: {
  device: Device;
  onClose: () => void;
  onDone: () => void;
  notify: (kind: 'ok' | 'error', message: string) => void;
}): JSX.Element {
  const type = device.descriptor.type;
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState<string | null>(null);
  const [stage, setStage] = useState<'start' | 'code'>('start');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const attempt = async (body: Record<string, unknown>, after: (result: Awaited<ReturnType<typeof api.pair>>) => void) => {
    setBusy(true);
    setError(null);
    try {
      after(await api.pair(device.descriptor.id, body));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = (message: string): void => {
    notify('ok', message);
    onDone();
    onClose();
  };

  let body: JSX.Element;
  let footer: JSX.Element;

  if (type === 'nanoleaf') {
    body = (
      <>
        <p>
          Hold the power button on the Nanoleaf controller for <strong>5 to 7 seconds</strong>, until the LED starts
          flashing. Then press Pair below within 30 seconds.
        </p>
        <p className="muted">The hub stores the token it is given; your Nanoleaf account is not involved.</p>
      </>
    );
    footer = (
      <Button
        variant="primary"
        busy={busy}
        onClick={() => void attempt({}, () => finish('Nanoleaf paired'))}
      >
        Pair
      </Button>
    );
  } else if (type === 'ecobee') {
    body = (
      <>
        <ol className="steps">
          <li>Press <strong>Get PIN</strong> below.</li>
          <li>
            Sign in at <code>ecobee.com</code>, open <strong>My Apps</strong> and choose{' '}
            <strong>Add Application</strong>.
          </li>
          <li>Enter the PIN, then press <strong>Complete</strong> here.</li>
        </ol>
        {pin ? (
          <div className="pin">
            <span>{pin}</span>
            <small>valid for about 9 minutes</small>
          </div>
        ) : null}
      </>
    );
    footer = (
      <>
        <Button busy={busy} onClick={() => void attempt({ step: 'start' }, (r) => setPin(r.pin ?? null))}>
          Get PIN
        </Button>
        <Button
          variant="primary"
          disabled={!pin}
          busy={busy}
          onClick={() => void attempt({ step: 'complete' }, () => finish('Ecobee paired'))}
        >
          Complete
        </Button>
      </>
    );
  } else if (type === 'ring') {
    body =
      stage === 'start' ? (
        <>
          <p>
            Ring has no public API, so the hub signs in the way the Ring app does. Only the resulting refresh token is
            saved &mdash; your password is never written to disk.
          </p>
          <Field label="Ring email">
            <input
              type="email"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label="Ring password">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </>
      ) : (
        <>
          <p>Ring sent a verification code. Enter it to finish.</p>
          <Field label="Verification code">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </Field>
        </>
      );
    footer =
      stage === 'start' ? (
        <Button
          variant="primary"
          busy={busy}
          disabled={!username || !password}
          onClick={() =>
            void attempt({ step: 'start', username, password }, (result) => {
              if (result.paired) finish('Ring paired');
              else {
                setStage('code');
                // The password is no longer needed once the hub holds the session.
                setPassword('');
                if (result.message) notify('ok', result.message);
              }
            })
          }
        >
          Sign in
        </Button>
      ) : (
        <Button
          variant="primary"
          busy={busy}
          disabled={code.length < 4}
          onClick={() => void attempt({ step: 'verify', code }, () => finish('Ring paired'))}
        >
          Verify
        </Button>
      );
  } else {
    body = <p>This device does not need pairing.</p>;
    footer = <Button onClick={onClose}>Close</Button>;
  }

  return (
    <Modal title={`Pair ${device.descriptor.name}`} onClose={onClose} footer={footer}>
      {body}
      {error ? <p className="inline-error">{error}</p> : null}
    </Modal>
  );
}
