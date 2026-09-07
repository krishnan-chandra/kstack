/** Pure pane-placement decisions for N hosted agents in one tab.
 *
 * The layout fills a grid: `ceil(sqrt(total))` columns, filled column by
 * column, then row by row within each column. Agent 0 always reuses the tab's
 * root pane; every later agent splits an existing pane. When a column split
 * would make panes narrower than {@link MIN_COLUMN_COLUMNS}, the layout falls
 * back to fewer columns (down splits only) so no pane becomes too narrow.
 *
 * Ratio semantics match herdr 0.8.2: `pane split --ratio F` gives the source
 * (left/top) pane the fraction F of its current extent and the new pane the
 * remainder. Each down split therefore keeps `1 / remainingRowsInColumn` of
 * the pane it splits, which yields equal row heights once the grid is full.
 */

interface PaneGeometry {
	/** Width of the tab in terminal columns. */
	widthColumns: number;
}

/** Minimum width of any pane produced by a column split. */
export const MIN_COLUMN_COLUMNS = 60;

export type AgentPanePlacement = {
	/** Pane to split: the tab's root pane, or a previous agent pane by index. */
	splitFrom: "root" | number;
	direction: "right" | "down";
	ratio: number;
};

/** Decide where agent `index` (0-based) of `total` agents is placed.
 *
 * Returns undefined for index 0: the first agent uses the tab's root pane.
 * Requires 1 ≤ total ≤ 8 and 0 ≤ index < total.
 */
export function placeAgent(index: number, total: number, geometry: PaneGeometry): AgentPanePlacement | undefined {
	if (total < 1 || total > 8 || index < 0 || index >= total) return undefined;
	if (index === 0) return undefined;
	const maxColumns = Math.max(1, Math.floor(geometry.widthColumns / MIN_COLUMN_COLUMNS));
	const columns = Math.min(ceilSqrt(total), maxColumns);
	if (index < columns) {
		// New column i: split the previous column's rest pane to the right.
		// The source keeps 1/(columns - i + 1) so all columns end up equal.
		return { splitFrom: index - 1 === 0 ? "root" : index - 1, direction: "right", ratio: 1 / (columns - index + 1) };
	}
	// Fill down: agent i goes under agent i - columns.
	const column = index % columns;
	const rows = Math.ceil((total - column) / columns);
	const sourceRow = Math.floor((index - column) / columns) - 1;
	return { splitFrom: index - columns, direction: "down", ratio: 1 / (rows - sourceRow) };
}

function ceilSqrt(total: number): number {
	let columns = 1;
	while (columns * columns < total) columns++;
	return columns;
}
