declare module "jpeg-js" {
  export interface JpegEncoded {
    data: Uint8Array;
    width: number;
    height: number;
  }
  export function encode(
    image: { data: Uint8Array; width: number; height: number },
    quality?: number,
  ): JpegEncoded;
  const jpeg: { encode: typeof encode };
  export default jpeg;
}
