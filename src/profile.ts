/** Sensor/lens contract. Model mods supply these numbers; airframes supply the mount. */
export interface CameraProfile {
  sensorW: number;
  sensorH: number;
  diagonalFovDeg: number;
  hfovRad: number;
  vfovRad: number;
  exifModel: string;
  focalMm: number;
  focal35mm: number;
  exposureDen: number;
  make: string;
  software: string;
  xmpNamespace: string;
  jpegQuality: number;
}

export function fovFromDiagonal(widthPx: number, heightPx: number, diagonalDeg: number): { hfovRad: number; vfovRad: number } {
  const diagonal = Math.hypot(widthPx, heightPx);
  const tanHalf = Math.tan(diagonalDeg * Math.PI / 360);
  return {
    hfovRad: 2 * Math.atan((widthPx / diagonal) * tanHalf),
    vfovRad: 2 * Math.atan((heightPx / diagonal) * tanHalf),
  };
}
