import { translator, type Translate } from '@/lib/webchat/strings';

/** Shown for unknown/disabled channels, an unreachable API, or a host site outside the allowlist. */
export function ChatUnavailable({ t = translator('en') }: { t?: Translate }) {
  return (
    <div className="wc">
      <div className="wc-center" role="alert">
        <h2>{t('unavailable.title')}</h2>
        <p>{t('unavailable.body')}</p>
      </div>
    </div>
  );
}
