/** A rectangle in Spine coordinates, where y grows upwards. */
export interface SpineRect { minX: number; maxX: number; minY: number; maxY: number }
export interface SpinePoint { x: number; y: number }
/** A point on the canvas in CSS pixels from its top left corner. */
export interface CanvasPoint { x: number; y: number }
/** The canvas in CSS pixels, and the bottom band reserved for animation below the character's soles. */
export interface CanvasLayout { cssWidth: number; cssHeight: number; bandPx: number }
/** The fixed camera: CSS pixels per Spine unit and the Spine rectangle the whole canvas shows. */
export interface CameraFit extends SpineRect { unitPx: number; cssWidth: number; cssHeight: number }
/** A camera to draw with: the Spine point at the centre of the canvas and the zoom (1 = the fixed camera, 2 = everything
 * at half size). */
export interface CameraView { x: number; y: number; zoom: number }

/** A layout whose band is too low for the part of the character below its soles: that part needs `neededPx` CSS
 * pixels but the band has `availablePx`. It stays a `RangeError` like every refusal here; the numbers let the screen
 * name them without reading the (English, developer-facing) message. */
export class CameraLayoutError extends RangeError {
  constructor(message: string, readonly neededPx: number, readonly availablePx: number) {
    super(message);
    this.name = "CameraLayoutError";
  }
}

/** The one camera for every body animation (design section 7.3): the largest scale at which the whole `content` range
 * fits across and the part above the soles fits above the band. The soles (`floorY`) sit on the top edge of the band
 * and the range is centred across. The part below the soles (a sleeping tail, crouched feet) then has only the band's
 * height; a band too low for it is refused with the numbers instead of cutting that part off unseen. */
export function fitCamera(layout: CanvasLayout, content: SpineRect, floorY: number): CameraFit {
  const { cssWidth, cssHeight, bandPx } = layout;
  if (!(cssWidth > 0 && cssHeight > 0 && bandPx >= 0 && bandPx < cssHeight)) {
    throw new RangeError(`A ${cssWidth}x${cssHeight} canvas cannot hold a ${bandPx}px band`);
  }
  if (!(content.maxX > content.minX && content.maxY > floorY && floorY >= content.minY)) {
    throw new RangeError(`The content range x ${content.minX}..${content.maxX}, y ${content.minY}..${content.maxY} does not hold the floor ${floorY}`);
  }
  const unitPx = Math.min(cssWidth / (content.maxX - content.minX), (cssHeight - bandPx) / (content.maxY - floorY));
  const belowFloorPx = (floorY - content.minY) * unitPx;
  if (belowFloorPx > bandPx) {
    throw new CameraLayoutError(`The content below the floor needs ${belowFloorPx}px at ${unitPx}px per unit, but the band is ${bandPx}px on a ${cssWidth}x${cssHeight} canvas`, belowFloorPx, bandPx);
  }
  const halfWidth = cssWidth / unitPx / 2;
  const centerX = (content.minX + content.maxX) / 2;
  const minY = floorY - bandPx / unitPx;
  return { unitPx, cssWidth, cssHeight, minX: centerX - halfWidth, maxX: centerX + halfWidth, minY, maxY: minY + cssHeight / unitPx };
}

/** The centre of a bounds rectangle as `Skeleton.getBoundsRect()` returns it: the anchor of the startup flight is the
 * centre of the setup pose. */
export function boundsCenter(bounds: { x: number; y: number; width: number; height: number }): SpinePoint {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** Where the startup flight begins: across the middle of the canvas, `startTopPx` below its top. */
export function flightStartPoint(fit: CameraFit, startTopPx: number): CanvasPoint {
  return { x: fit.cssWidth / 2, y: startTopPx };
}

/** The camera for one frame of the startup presentation: everything drawn at `presentation.scale` of its size, with
 * the `anchor` on the canvas at its place moved `presentation.lift` of the way to `start`. Only the camera moves, so
 * the physics of ears and wings never sees the change of size (decision D5). Writes into `out` to allocate nothing. */
export function presentCamera(base: CameraFit, anchor: SpinePoint, presentation: { scale: number; lift: number }, start: CanvasPoint, out: CameraView): void {
  const scale = presentation.scale;
  if (!(scale > 0)) throw new RangeError(`The presentation scale ${scale} is not above 0`);
  const homeX = (anchor.x - base.minX) * base.unitPx;
  const homeY = (base.maxY - anchor.y) * base.unitPx;
  const targetX = homeX + presentation.lift * (start.x - homeX);
  const targetY = homeY + presentation.lift * (start.y - homeY);
  const unitPx = base.unitPx * scale;
  out.x = anchor.x - (targetX - base.cssWidth / 2) / unitPx;
  out.y = anchor.y + (targetY - base.cssHeight / 2) / unitPx;
  out.zoom = 1 / scale;
}
