import type { ParsedManifest, ManifestSegment, ManifestVariant, AudioRendition } from "../types";

/** Đọc thuộc tính dạng quoted-string, ví dụ GROUP-ID="aud2". */
function parseAttrString(attrs: string, key: string): string | null {
  const match = attrs.match(new RegExp(`${key}="([^"]*)"`, "i"));
  return match ? match[1] : null;
}

/** Đọc thuộc tính dạng enumerated-string không có dấu ngoặc kép, ví dụ TYPE=AUDIO. */
function parseAttrEnum(attrs: string, key: string): string | null {
  const match = attrs.match(new RegExp(`${key}=([^,]+)`, "i"));
  return match ? match[1].trim() : null;
}

/**
 * Parser HLS playlist tối giản theo RFC 8216, đủ dùng cho việc giám sát:
 * - Media playlist: media-sequence, target-duration, danh sách segment, endlist (VOD/kết thúc).
 * - Master playlist: danh sách variant (sub-stream) theo bandwidth, và các audio rendition
 *   tách riêng (#EXT-X-MEDIA:TYPE=AUDIO) - rất phổ biến ở luồng broadcast thật.
 */
export function parseM3U8(content: string): ParsedManifest {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0 || !lines[0].startsWith("#EXTM3U")) {
    throw new Error("Không phải file HLS hợp lệ (thiếu #EXTM3U)");
  }

  const segments: ManifestSegment[] = [];
  const variants: ManifestVariant[] = [];
  const audioRenditions: AudioRendition[] = [];

  let targetDuration: number | null = null;
  let mediaSequence: number | null = null;
  let endList = false;

  let pendingSegmentDuration: number | null = null;
  let pendingVariant: { bandwidth: number; audioGroupId: string | null } | null = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.split(":")[1]);
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.split(":")[1]);
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      endList = true;
    } else if (line.startsWith("#EXTINF:")) {
      const value = line.substring("#EXTINF:".length).split(",")[0];
      pendingSegmentDuration = Number(value);
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = line.substring("#EXT-X-MEDIA:".length);
      const type = parseAttrEnum(attrs, "TYPE");
      const groupId = parseAttrString(attrs, "GROUP-ID");
      const uri = parseAttrString(attrs, "URI");
      if (type === "AUDIO" && groupId && uri) {
        audioRenditions.push({ groupId, uri });
      }
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = line.substring("#EXT-X-STREAM-INF:".length);
      const bandwidthMatch = attrs.match(/(?:^|,)BANDWIDTH=(\d+)/i);
      pendingVariant = {
        bandwidth: bandwidthMatch ? Number(bandwidthMatch[1]) : 0,
        audioGroupId: parseAttrString(attrs, "AUDIO"),
      };
    } else if (!line.startsWith("#")) {
      // Đây là dòng URI - phụ thuộc vào tag ngay trước đó
      if (pendingVariant !== null) {
        variants.push({ uri: line, bandwidth: pendingVariant.bandwidth, audioGroupId: pendingVariant.audioGroupId });
        pendingVariant = null;
      } else if (pendingSegmentDuration !== null) {
        segments.push({ uri: line, duration: pendingSegmentDuration });
        pendingSegmentDuration = null;
      }
      // Nếu không có tag EXTINF/STREAM-INF phía trước, bỏ qua dòng URI mồ côi
    }
  }

  const isMaster = variants.length > 0 && segments.length === 0;

  return {
    isMaster,
    targetDuration,
    mediaSequence,
    endList,
    segments,
    variants,
    audioRenditions,
  };
}

/** Chọn variant có bandwidth cao nhất trong master playlist để theo dõi chất lượng cao nhất. */
export function pickHighestBandwidthVariant(manifest: ParsedManifest): ManifestVariant | null {
  if (manifest.variants.length === 0) return null;
  return manifest.variants.reduce((best, current) => (current.bandwidth > best.bandwidth ? current : best));
}

/** Tìm audio rendition tương ứng với AUDIO group-id khai báo trên variant đã chọn. */
export function findAudioRenditionForVariant(manifest: ParsedManifest, variant: ManifestVariant): AudioRendition | null {
  if (!variant.audioGroupId) return null;
  return manifest.audioRenditions.find((r) => r.groupId === variant.audioGroupId) ?? null;
}

/** Ghép URI tương đối với base URL của manifest cha. */
export function resolveUri(baseUrl: string, uri: string): string {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return uri;
  }
}
