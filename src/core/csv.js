// The countries of one variable-year as a file.
//
// Built in the browser rather than served: the backend already sent these
// numbers to draw the view, and a second round trip to get them punctuated
// differently would be a second chance for the two to disagree.
//
// It lives here rather than in either controller because there are two ways to
// ask for it — the table view's own button and the data-table dialog's — and a
// file that came out of this application should have one shape whichever button
// produced it.
//
// ---- why the first four columns are what they are ----
//
// The download used to name the variable-year in the *filename* only, which is
// a place a file loses: renamed once, or its rows pasted under another year's in
// a spreadsheet, and there is nothing left saying what the numbers measure or
// when. So every row carries its own dataset, variable and year. That also makes
// several of these files concatenate into one honest table, which is the obvious
// next thing to do with them.

function escapeCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const COLUMNS = [
  // What the numbers are and when, on every row. See the note above.
  { header: "dataset", of: (_row, selection) => selection.dataset },
  { header: "dataset_title", of: (_row, selection) => selection.datasetTitle },
  { header: "variable", of: (_row, selection) => selection.variable },
  { header: "variable_title", of: (_row, selection) => selection.variableTitle },
  { header: "year", of: (_row, selection) => selection.year },
  // Position in the order the view was showing, which is a fact about the sort
  // and not about the country -- hence its place after the identifying columns
  // rather than at the head of the row.
  { header: "rank", of: (_row, _selection, index) => index + 1 },
  { header: "country", of: (row) => row.country },
  { header: "iso3", of: (row) => row.iso3 },
  { header: "value", of: (row) => row.value },
  { header: "class", of: (row) => row.classIndex },
  { header: "status", of: (row) => (row.value === null ? "no data" : "has value") },
  // The raw source key rather than the display label: a file that outlives this
  // page is more use joined back to the database than read aloud.
  { header: "boundary_source", of: (row) => row.geometrySource },
  { header: "boundary_valid_from", of: (row) => row.validFromYear },
  { header: "boundary_valid_to", of: (row) => row.validToYear },
  { header: "boundary_confidence", of: (row) => row.geometryConfidence },
];

export function buildCountryRowsCsv(rows, selection) {
  const lines = [COLUMNS.map((column) => column.header).join(",")];
  rows.forEach((row, index) => {
    lines.push(COLUMNS.map((column) => escapeCell(column.of(row, selection, index))).join(","));
  });
  return `${lines.join("\n")}\n`;
}

// `rows` in the order the view is showing them, and `selection` as either
// controller's `describeSelection()` returns it.
export function downloadCountryRowsCsv(rows, selection) {
  if (!Array.isArray(rows) || rows.length === 0) return;

  const blob = new Blob([buildCountryRowsCsv(rows, selection)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  // The filename still names the variable-year. It is the first thing a reader
  // sees and the thing a download folder sorts by; it is just no longer the
  // only place the file says so.
  link.download = `demscore-${selection.dataset}-${selection.variable}-${selection.year}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
