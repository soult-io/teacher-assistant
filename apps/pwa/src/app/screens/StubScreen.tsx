// Placeholder for a surface built in a later unit (Plan = Phase 2; the Para
// surface = U6). Keeps the chrome navigable without implying unbuilt behavior.

export function StubScreen({ title, note }: { readonly title: string; readonly note: string }) {
  return (
    <div className="stub">
      <h1>{title}</h1>
      <span className="comingsoon">{note}</span>
    </div>
  );
}
