/**
 * Kagane API TypeScript interfaces and normalizer.
 *
 * Mirrors the Python dataclasses in src/scraper/api_models.py.
 * All keys are camelCase; snake_case JSON keys are mapped in normalizeSeries().
 */

// ──────────────────────────────────────────
// Constants
// ──────────────────────────────────────────

export const IMAGE_BASE_URL = 'https://kagane.moe/api/v2/image';

export function getImageUrl(imageId: string): string {
  return `${IMAGE_BASE_URL}/${imageId}`;
}

// ──────────────────────────────────────────
// Interfaces
// ──────────────────────────────────────────

export interface Genre {
  genreId: string;
  genreName: string;
  isSpoiler: boolean;
}

export interface Tag {
  tagId: string;
  tagName: string;
  isSpoiler: boolean;
}

export interface AlternateTitle {
  label: string;
  title: string;
}

export interface Group {
  groupId: string;
  title: string;
  avatarImageId: string;
}

export interface Uploader {
  userId: string;
  username: string;
  avatarImageId: string;
  /** Maps from JSON key 'class' (reserved word in JS/TS) */
  userClass: string;
}

export interface Book {
  bookId: string;
  chapterNo: string;
  title: string;
  sortNo: number;
  pageCount: number;
  views: number;
  createdAt: string;
  updatedAt: string;
  volumeNo?: string | null;
  publishedOn?: string | null;
  internalRelease: boolean;
  optionalData?: Record<string, unknown> | null;
  groups: Group[];
  uploader?: Uploader | null;
}

export interface SeriesCover {
  coverId: string;
  imageId: string;
  chapterNumber: string;
  volumeNumber?: string | null;
  language: string;
  note?: string | null;

  /** Get the full cover image URL */
  get url(): string;
}

export interface SeriesLink {
  label: string;
  url: string;
}

export interface SeriesStaff {
  staffId: string;
  name: string;
  role: string;
}

export interface Series {
  seriesId: string;
  title: string;
  description: string;
  format: string;
  contentRating: string;
  publicationStatus: string;
  uploadStatus: string;
  originalLanguage: string;
  translatedLanguage: string;
  titleLanguage: string;
  currentBooks: number;
  totalViews: number;
  createdAt: string;
  updatedAt: string;
  sourceId: string;
  trackerId: string;
  averageRating?: number | null;
  bayesianRating?: number | null;
  totalRatings?: number | null;
  startYear?: number | null;
  endYear?: number | null;
  currentVolumes?: number | null;
  totalVolumes?: number | null;
  totalBooks?: number | null;
  editionInfo?: string | null;
  distribution?: string | null;
  localCover?: string | null;
  genres: Genre[];
  tags: Tag[];
  seriesAlternateTitles: AlternateTitle[];
  seriesBooks: Book[];
  seriesCovers: SeriesCover[];
  seriesLinks: SeriesLink[];
  seriesStaff: SeriesStaff[];

  /** Get the cover image URL from the first cover */
  get coverUrl(): string;
}

// ──────────────────────────────────────────
// Helper: create a SeriesCover with a getter
// ──────────────────────────────────────────

export function createSeriesCover(data: {
  coverId?: string;
  imageId?: string;
  chapterNumber?: string;
  volumeNumber?: string | null;
  language?: string;
  note?: string | null;
}): SeriesCover {
  return {
    coverId: data.coverId ?? '',
    imageId: data.imageId ?? '',
    chapterNumber: data.chapterNumber ?? '',
    volumeNumber: data.volumeNumber ?? null,
    language: data.language ?? '',
    note: data.note ?? null,
    get url(): string {
      return this.imageId ? getImageUrl(this.imageId) : '';
    },
  };
}

export function createSeries(data: {
  seriesId?: string;
  title?: string;
  description?: string;
  format?: string;
  contentRating?: string;
  publicationStatus?: string;
  uploadStatus?: string;
  originalLanguage?: string;
  translatedLanguage?: string;
  titleLanguage?: string;
  currentBooks?: number;
  totalViews?: number;
  createdAt?: string;
  updatedAt?: string;
  sourceId?: string;
  trackerId?: string;
  averageRating?: number | null;
  bayesianRating?: number | null;
  totalRatings?: number | null;
  startYear?: number | null;
  endYear?: number | null;
  currentVolumes?: number | null;
  totalVolumes?: number | null;
  totalBooks?: number | null;
  editionInfo?: string | null;
  distribution?: string | null;
  localCover?: string | null;
  genres?: Genre[];
  tags?: Tag[];
  seriesAlternateTitles?: AlternateTitle[];
  seriesBooks?: Book[];
  seriesCovers?: SeriesCover[];
  seriesLinks?: SeriesLink[];
  seriesStaff?: SeriesStaff[];
}): Series {
  return {
    seriesId: data.seriesId ?? '',
    title: data.title ?? '',
    description: data.description ?? '',
    format: data.format ?? '',
    contentRating: data.contentRating ?? '',
    publicationStatus: data.publicationStatus ?? '',
    uploadStatus: data.uploadStatus ?? '',
    originalLanguage: data.originalLanguage ?? '',
    translatedLanguage: data.translatedLanguage ?? '',
    titleLanguage: data.titleLanguage ?? '',
    currentBooks: data.currentBooks ?? 0,
    totalViews: data.totalViews ?? 0,
    createdAt: data.createdAt ?? '',
    updatedAt: data.updatedAt ?? '',
    sourceId: data.sourceId ?? '',
    trackerId: data.trackerId ?? '',
    averageRating: data.averageRating ?? null,
    bayesianRating: data.bayesianRating ?? null,
    totalRatings: data.totalRatings ?? null,
    startYear: data.startYear ?? null,
    endYear: data.endYear ?? null,
    currentVolumes: data.currentVolumes ?? null,
    totalVolumes: data.totalVolumes ?? null,
    totalBooks: data.totalBooks ?? null,
    editionInfo: data.editionInfo ?? null,
    distribution: data.distribution ?? null,
    localCover: data.localCover ?? null,
    genres: data.genres ?? [],
    tags: data.tags ?? [],
    seriesAlternateTitles: data.seriesAlternateTitles ?? [],
    seriesBooks: data.seriesBooks ?? [],
    seriesCovers: data.seriesCovers ?? [],
    seriesLinks: data.seriesLinks ?? [],
    seriesStaff: data.seriesStaff ?? [],
    get coverUrl(): string {
      return this.seriesCovers.length > 0 && this.seriesCovers[0].imageId
        ? this.seriesCovers[0].url
        : '';
    },
  };
}

// ──────────────────────────────────────────
// Parser helpers for snake_case JSON → typed interfaces
// ──────────────────────────────────────────

function parseGenre(data: Record<string, unknown>): Genre {
  return {
    genreId: String(data.genre_id ?? ''),
    genreName: String(data.genre_name ?? ''),
    isSpoiler: Boolean(data.is_spoiler ?? false),
  };
}

function parseTag(data: Record<string, unknown>): Tag {
  return {
    tagId: String(data.tag_id ?? ''),
    tagName: String(data.tag_name ?? ''),
    isSpoiler: Boolean(data.is_spoiler ?? false),
  };
}

function parseAlternateTitle(data: Record<string, unknown>): AlternateTitle {
  return {
    label: String(data.label ?? ''),
    title: String(data.title ?? ''),
  };
}

function parseGroup(data: Record<string, unknown>): Group {
  return {
    groupId: String(data.group_id ?? ''),
    title: String(data.title ?? ''),
    avatarImageId: String(data.avatar_image_id ?? ''),
  };
}

function parseUploader(data: Record<string, unknown>): Uploader {
  return {
    userId: String(data.user_id ?? ''),
    username: String(data.username ?? ''),
    avatarImageId: String(data.avatar_image_id ?? ''),
    // JSON key 'class' is a reserved word; map to userClass
    userClass: String(data.class ?? ''),
  };
}

function parseBook(data: Record<string, unknown>): Book {
  const groups: Group[] = Array.isArray(data.groups)
    ? data.groups.map((g: Record<string, unknown>) => parseGroup(g))
    : [];
  const uploader: Uploader | null =
    data.uploader && typeof data.uploader === 'object'
      ? parseUploader(data.uploader as Record<string, unknown>)
      : null;

  return {
    bookId: String(data.book_id ?? ''),
    chapterNo: String(data.chapter_no ?? ''),
    title: String(data.title ?? ''),
    sortNo: Number(data.sort_no ?? 0),
    pageCount: Number(data.page_count ?? 0),
    views: Number(data.views ?? 0),
    createdAt: String(data.created_at ?? ''),
    updatedAt: String(data.updated_at ?? ''),
    volumeNo: data.volume_no != null ? String(data.volume_no) : null,
    publishedOn: data.published_on != null ? String(data.published_on) : null,
    internalRelease: Boolean(data.internal_release ?? false),
    optionalData: data.optional_data != null ? (data.optional_data as Record<string, unknown>) : null,
    groups,
    uploader,
  };
}

function parseSeriesCover(data: Record<string, unknown>): SeriesCover {
  return createSeriesCover({
    coverId: String(data.cover_id ?? ''),
    imageId: String(data.image_id ?? ''),
    chapterNumber: String(data.chapter_number ?? ''),
    volumeNumber: data.volume_number != null ? String(data.volume_number) : null,
    language: String(data.language ?? ''),
    note: data.note != null ? String(data.note) : null,
  });
}

function parseSeriesLink(data: Record<string, unknown>): SeriesLink {
  return {
    label: String(data.label ?? ''),
    url: String(data.url ?? ''),
  };
}

function parseSeriesStaff(data: Record<string, unknown>): SeriesStaff {
  return {
    staffId: String(data.staff_id ?? ''),
    name: String(data.name ?? ''),
    role: String(data.role ?? ''),
  };
}

/**
 * Parse the packed chapter list from /series/{id}/books/index.
 * Response shape: { fields: string[], books: unknown[][] }
 */
export function parseBooks(data: Record<string, unknown>): Book[] {
  const fields = Array.isArray(data.fields) ? data.fields.map(String) : [];
  const rows = Array.isArray(data.books) ? data.books : [];

  return rows.map((row) => {
    const values = Array.isArray(row) ? row : [];
    const record: Record<string, unknown> = {};
    fields.forEach((field, index) => {
      record[field] = values[index];
    });
    record.created_at = record.published_on ?? '';
    return parseBook(record);
  });
}

/**
 * Parse raw snake_case API JSON into a fully typed Series object.
 * Safe to call with partial/missing data — all fields default to empty values.
 */
export function normalizeSeries(data: Record<string, unknown>): Series {
  const genres: Genre[] = Array.isArray(data.genres)
    ? data.genres.map((g: Record<string, unknown>) => parseGenre(g))
    : [];

  const tags: Tag[] = Array.isArray(data.tags)
    ? data.tags.map((t: Record<string, unknown>) => parseTag(t))
    : [];

  const altTitles: AlternateTitle[] = Array.isArray(data.series_alternate_titles)
    ? data.series_alternate_titles.map((t: Record<string, unknown>) => parseAlternateTitle(t))
    : [];

  const books: Book[] = Array.isArray(data.series_books)
    ? data.series_books.map((b: Record<string, unknown>) => parseBook(b))
    : [];

  const covers: SeriesCover[] = Array.isArray(data.series_covers)
    ? data.series_covers.map((c: Record<string, unknown>) => parseSeriesCover(c))
    : [];

  const links: SeriesLink[] = Array.isArray(data.series_links)
    ? data.series_links.map((l: Record<string, unknown>) => parseSeriesLink(l))
    : [];

  const staff: SeriesStaff[] = Array.isArray(data.series_staff)
    ? data.series_staff.map((s: Record<string, unknown>) => parseSeriesStaff(s))
    : [];

  return createSeries({
    seriesId: String(data.series_id ?? ''),
    title: String(data.title ?? ''),
    description: String(data.description ?? ''),
    format: String(data.format ?? ''),
    contentRating: String(data.content_rating || data.age_rating || ''),
    publicationStatus: String(data.publication_status ?? ''),
    uploadStatus: String(data.upload_status ?? ''),
    originalLanguage: String(data.original_language ?? ''),
    translatedLanguage: String(data.translated_language ?? ''),
    titleLanguage: String(data.title_language ?? ''),
    currentBooks: Number(data.current_books ?? 0),
    totalViews: Number(data.total_views ?? 0),
    createdAt: String(data.created_at ?? ''),
    updatedAt: String(data.updated_at ?? ''),
    sourceId: String(data.source_id ?? ''),
    trackerId: String(data.tracker_id ?? ''),
    averageRating: data.average_rating != null ? Number(data.average_rating) : null,
    bayesianRating: data.bayesian_rating != null ? Number(data.bayesian_rating) : null,
    totalRatings: data.total_ratings != null ? Number(data.total_ratings) : null,
    startYear: data.start_year != null ? Number(data.start_year) : null,
    endYear: data.end_year != null ? Number(data.end_year) : null,
    currentVolumes: data.current_volumes != null ? Number(data.current_volumes) : null,
    totalVolumes: data.total_volumes != null ? Number(data.total_volumes) : null,
    totalBooks: data.total_books != null ? Number(data.total_books) : null,
    editionInfo: data.edition_info != null ? String(data.edition_info) : null,
    distribution: data.distribution != null ? String(data.distribution) : null,
    localCover: data.local_cover != null ? String(data.local_cover) : null,
    genres,
    tags,
    seriesAlternateTitles: altTitles,
    seriesBooks: books,
    seriesCovers: covers,
    seriesLinks: links,
    seriesStaff: staff,
  });
}

export default normalizeSeries;
