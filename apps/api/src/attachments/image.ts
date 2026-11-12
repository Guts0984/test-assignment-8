import sharp from 'sharp';
import type { AllowedMime } from './sniff';

const MAX_PIXELS = 40_000_000; // a decompression bomb is refused before it is decoded

/**
 * Decodes an uploaded image and encodes it again. What is stored is OUR encoding of the pixels, so anything that is
 * not pixels — executable bytes in a comment block / ancillary chunk / trailing data, EXIF, embedded profiles — is gone,
 * and a file that is not a decodable image of its claimed type is refused (returns null).
 */
export const reencodeImage = async (
  bytes: Uint8Array,
  mime: Extract<AllowedMime, `image/${string}`>,
): Promise<Buffer | null> => {
  try {
    const animated = mime === 'image/gif' || mime === 'image/webp';
    const img = sharp(bytes, {
      limitInputPixels: MAX_PIXELS,
      failOn: 'warning',
      animated,
      sequentialRead: true,
    });
    const meta = await img.metadata();
    if (meta.format !== mime.slice('image/'.length)) return null; // the decoder disagrees with the signature
    const oriented = img.rotate(); // bake the EXIF orientation in before the metadata is dropped
    switch (mime) {
      case 'image/png':
        return await oriented.png({ compressionLevel: 6 }).toBuffer();
      case 'image/jpeg':
        return await oriented.jpeg({ quality: 92 }).toBuffer();
      case 'image/gif':
        return await oriented.gif().toBuffer();
      case 'image/webp':
        return await oriented.webp({ quality: 92 }).toBuffer();
    }
  } catch {
    return null;
  }
};
