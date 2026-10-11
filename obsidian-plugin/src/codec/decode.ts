// decode turns image bytes into RGBA pixels with the platform's decoder,
// which applies EXIF orientation and works the same on desktop and mobile.
export async function decode(source: ArrayBuffer): Promise<ImageData> {
  const bitmap = await createImageBitmap(new Blob([source]));
  try {
    const canvas = document.createElement('canvas'); // OffscreenCanvas is missing on older iOS
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas is not available');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
