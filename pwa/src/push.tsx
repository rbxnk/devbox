// Turning notifications on for this browser.
import { useEffect, useState } from 'preact/hooks';
import { token } from './state.ts';

const call = (method: string, body?: unknown) =>
  fetch('/api/push', { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

const bytes = (b64url: string) => Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export function PushToggle() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => setOn(!!s), () => setOn(false));
  }, []);

  if (!supported) {
    // iOS only offers push to an app on the home screen.
    return <p class="hint pad">To get notifications on an iPhone, add this app to the home screen (Share, then Add to Home Screen) and open it from there.</p>;
  }
  const toggle = async () => {
    setError('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await call('POST', { unsubscribe: existing.endpoint });
        await existing.unsubscribe();
        setOn(false);
        return;
      }
      if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings.');
      const { key } = await (await call('GET')).json();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
      const res = await call('POST', { subscription: sub.toJSON() });
      if (!res.ok) { await sub.unsubscribe(); throw new Error('The bridge refused the subscription.'); }
      setOn(true);
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <div class="push">
      <button class="row-button" role="switch" aria-checked={on === true} disabled={on === null} onClick={toggle}>
        Notify me when an agent needs me or finishes <span class="switch" aria-hidden="true" />
      </button>
      {error && <p class="error pad" role="alert">{error}</p>}
    </div>
  );
}
