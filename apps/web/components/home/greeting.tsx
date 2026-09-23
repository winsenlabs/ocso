/** Home greeting (design/06): first name, a one-line status, and a strip of plain facts. */
export function Greeting({ name, tail, strip }: { name: string; tail: string; strip: string[] }) {
  return (
    <div className="greeting">
      <h1>
        {name}, <em>{tail}</em>
      </h1>
      <div className="greeting-strip">{strip.filter(Boolean).join(' · ')}</div>
    </div>
  );
}
