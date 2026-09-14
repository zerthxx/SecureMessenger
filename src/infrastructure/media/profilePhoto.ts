import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

/** Square edge length of an uploaded profile photo — sharp at the largest avatar size on high-density screens, ~50–150 KB as JPEG. */
export const PROFILE_PHOTO_SIZE = 512;
const JPEG_QUALITY = 0.8;

export interface PickedPhoto {
  uri: string;
  width: number;
  height: number;
}

export interface PreparedProfilePhoto {
  /** Local `file://` uri of the processed image — used for the preview before saving. */
  uri: string;
  bytes: Uint8Array;
  mimeType: 'image/jpeg';
}

/**
 * Opens the system photo picker with a square crop step. On Android 13+ this
 * is the system Photo Picker, which needs no storage permission. Returns null
 * when the user backs out.
 */
export async function pickProfilePhoto(): Promise<PickedPhoto | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  return asset ? { uri: asset.uri, width: asset.width, height: asset.height } : null;
}

/**
 * Center-crops to a square (in case the crop step was skipped or ignored),
 * scales down to PROFILE_PHOTO_SIZE and re-encodes as JPEG. Re-encoding from
 * decoded pixels also leaves the original file's metadata (EXIF, including
 * any location) behind.
 */
export async function prepareProfilePhoto(photo: PickedPhoto): Promise<PreparedProfilePhoto> {
  const context = ImageManipulator.manipulate(photo.uri);
  const side = Math.min(photo.width, photo.height);
  if (side > 0) {
    if (photo.width !== photo.height) {
      context.crop({
        originX: Math.floor((photo.width - side) / 2),
        originY: Math.floor((photo.height - side) / 2),
        width: side,
        height: side,
      });
    }
    if (side > PROFILE_PHOTO_SIZE) {
      context.resize({ width: PROFILE_PHOTO_SIZE, height: PROFILE_PHOTO_SIZE });
    }
  } else {
    // Dimensions unknown: keep the aspect ratio and only bound the width.
    context.resize({ width: PROFILE_PHOTO_SIZE });
  }

  const image = await context.renderAsync();
  try {
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
    const bytes = await new File(saved.uri).bytes();
    return { uri: saved.uri, bytes, mimeType: 'image/jpeg' };
  } finally {
    image.release();
    context.release();
  }
}
