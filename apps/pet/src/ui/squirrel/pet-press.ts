/** How far (CSS px) the pointer moves with a button held before a press becomes a window drag instead of a click. */
export const DRAG_THRESHOLD_PX = 5;

/** The pet button's press: a click opens the input, and a move past `DRAG_THRESHOLD_PX` with a button held drags the
 * window. A press that began on the update button is never the pet button's (spec 7): its `cancel` ends a press the
 * pet button may still hold from a release outside it, so a move over the pet afterwards does not drag. */
export class PetPress {
  private origin: { x: number; y: number } | null = null;
  private dragged = false;

  down(x: number, y: number): void { this.origin = { x, y }; this.dragged = false; }

  /** True once, when this move turns the press into a drag. */
  move(x: number, y: number, buttons: number): boolean {
    if (!this.origin || !buttons || this.dragged || Math.hypot(x - this.origin.x, y - this.origin.y) < DRAG_THRESHOLD_PX) return false;
    this.dragged = true;
    return true;
  }

  up(): void { this.origin = null; }

  cancel(): void { this.origin = null; this.dragged = false; }

  /** Whether the click that ends the press opens the input. */
  click(): boolean { return !this.dragged; }
}
