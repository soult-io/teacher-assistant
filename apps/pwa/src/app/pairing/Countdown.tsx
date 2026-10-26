// "◷ 9:41 left" under a waiting pairing screen (flows A1, B3). Display only: the pairing
// layer decides expiry against its own clock.

import { useEffect, useState } from "react";

function left(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function Countdown({
  until,
  waiting,
}: {
  readonly until: number;
  readonly waiting: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="locknote pairwait" role="status">
      {waiting} <span className="mono">◷ {left(until - now)} left</span>
    </p>
  );
}
