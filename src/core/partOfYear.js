// Which part of the year a row may cover, in a year a state begins, ends or
// breaks up -- the one thing the map cannot show, since it draws one picture
// per year.
//
// `changes` is a row's `yearChanges` from /api/map-data (demscore.gw_year_changes):
//   from   this state begins during the year; before it, its ground was `other`'s
//   until  this state ends during the year; after it, its ground is `other`'s
//   loses  `other` begins during the year on part of this state's ground
//   gains  `other`'s ground joins this state during the year
// Only UCDP rows carry them, since UCDP's units are Gleditsch-Ward states.
//
// Deliberately vague. The table holds dates (CShapes 2.0's), but nothing says
// UCDP splits a year's events at those days, or at all -- that is asked of
// Demscore and unanswered. So the text says what is known, that the state
// changed during the year, and that the row *may* cover only part of it. It
// names no date and no month.

function joinWords(words) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function names(entries) {
  return [...new Set(entries.map((entry) => entry.other))].sort((a, b) => a.localeCompare(b));
}

// { short, full } for a row, or null when nothing changed during the year.
export function describePartOfYear(changes, year) {
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const of = (kind) => changes.filter((change) => change.kind === kind);
  const shorts = [];
  const fulls = [];

  for (const change of of("from")) {
    shorts.push(`new state in ${year}`);
    fulls.push(
      `Became a state during ${year}. This row may cover only part of the year; ` +
        `the rest may be counted in ${change.other}'s row.`,
    );
  }
  for (const change of of("until")) {
    shorts.push(`ended in ${year}`);
    fulls.push(
      `Ceased to be a state during ${year}. This row may cover only part of the year; ` +
        `the rest may be counted in ${change.other}'s row.`,
    );
  }
  const lost = names(of("loses"));
  if (lost.length === 1) {
    shorts.push(`lost ${lost[0]} in ${year}`);
    fulls.push(
      `${lost[0]} became a state of its own during ${year}. ` +
        "For part of the year this row may also count what happened on its ground.",
    );
  } else if (lost.length > 1) {
    shorts.push(`broke up in ${year}`);
    fulls.push(
      `${joinWords(lost)} became states of their own during ${year}. ` +
        "For part of the year this row may also count what happened on their ground.",
    );
  }
  for (const other of names(of("gains"))) {
    shorts.push(`joined by ${other} in ${year}`);
    fulls.push(
      `The ground of ${other} became part of this state during ${year}. ` +
        "For part of the year this row may also count what happened there.",
    );
  }

  if (shorts.length === 0) return null;
  return { short: shorts.join("; "), full: fulls.join(" ") };
}
