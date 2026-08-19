/**
 * Loading placeholders shaped like the thing that is coming.
 *
 * The point is not decoration, it is that the layout does not jump. A line of
 * text saying "Loading your dashboard…" occupies one row; the board occupies
 * most of the screen, so the old version moved every piece of furniture the
 * moment the data landed.
 *
 * `aria-hidden`, with a single live region carrying the word. A reader
 * announcing eleven grey rectangles is worse than silence.
 */

function Bar({ w }: { w: string }) {
  return <span className="sk-bar" style={{ width: w }} />;
}

export function ClassGridSkeleton() {
  return (
    <>
      <span className="sr-only" role="status">
        Loading your classes
      </span>
      <div className="class-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="class-card sk">
            <div className="class-card-band sk-block" />
            <div className="class-card-body">
              <Bar w="70%" />
              <Bar w="45%" />
              <div className="sk-spacer" />
              <Bar w="85%" />
              <Bar w="35%" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export function BoardSkeleton() {
  // Three, two, one: an even count in every column would read as a pattern
  // rather than as content that has not arrived.
  const counts = [3, 2, 1];
  return (
    <>
      <span className="sr-only" role="status">
        Loading your board
      </span>
      <div className="board" aria-hidden="true">
        {counts.map((n, col) => (
          <section key={col} className="column">
            <h2>
              <Bar w="3rem" />
            </h2>
            <ul className="list cards">
              {Array.from({ length: n }, (_, i) => (
                <li key={i} className="card sk">
                  <Bar w="80%" />
                  <Bar w="50%" />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
