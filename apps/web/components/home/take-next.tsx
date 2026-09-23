'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { takeNextAction } from '@/lib/actions/home';

/** "Take next conversation": claims the most urgent waiting conversation and opens it in the workspace. */
export function TakeNextButton({ available, waiting }: { available: boolean; waiting: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function take() {
    setMessage(null);
    start(async () => {
      const res = await takeNextAction();
      if (res.ok) router.push(`/conversations/${res.conversationId}`);
      else {
        setMessage(res.message);
        router.refresh();
      }
    });
  }

  return (
    <div className="take-next">
      <button type="button" className="btn accent" onClick={take} disabled={!available || pending} aria-describedby="take-next-note">
        {pending ? 'Claiming…' : 'Take next conversation'}
      </button>
      <span id="take-next-note" className="mono-sm" role="status">
        {message ?? (available ? `${waiting} waiting · the most urgent is claimed first` : 'nobody is waiting in your queues')}
      </span>
    </div>
  );
}
