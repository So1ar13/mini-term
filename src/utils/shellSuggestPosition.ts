export interface CursorCell {
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
}

export interface CellSize {
  cellWidth: number;
  cellHeight: number;
}

export function cursorCellToCssPosition(cursor: CursorCell, cell: CellSize, _rootZoom = 1): { left: number; top: number } {
  const visibleCursorY = cursor.baseY + cursor.cursorY - cursor.viewportY;
  return {
    left: cursor.cursorX * cell.cellWidth,
    top: visibleCursorY * cell.cellHeight,
  };
}
