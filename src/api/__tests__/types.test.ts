/**
 * Unit tests for types.ts — normalizeSeries() and helpers
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSeries,
  parseBooks,
  getImageUrl,
  createSeries,
  IMAGE_BASE_URL,
} from '../types';

// ──────────────────────────────────────────
// Sample data
// ──────────────────────────────────────────

const FULL_SERIES_JSON: Record<string, unknown> = {
  series_id: '12345',
  title: 'Test Series',
  description: 'A test series description.',
  format: 'Manga',
  content_rating: 'Safe',
  publication_status: 'Ongoing',
  upload_status: 'Active',
  original_language: 'ja',
  translated_language: 'en',
  title_language: 'en',
  current_books: 42,
  total_views: 1000000,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  source_id: 'src_001',
  tracker_id: 'trk_001',
  average_rating: 4.5,
  bayesian_rating: 4.2,
  total_ratings: 500,
  start_year: 2020,
  end_year: null,
  current_volumes: 10,
  total_volumes: 20,
  total_books: 200,
  edition_info: 'First Edition',
  distribution: 'worldwide',
  local_cover: null,

  genres: [
    { genre_id: 'g1', genre_name: 'Action', is_spoiler: false },
    { genre_id: 'g2', genre_name: 'Romance', is_spoiler: true },
  ],

  tags: [
    { tag_id: 't1', tag_name: 'Popular', is_spoiler: false },
  ],

  series_alternate_titles: [
    { label: 'Japanese', title: 'テストシリーズ' },
  ],

  series_books: [
    {
      book_id: 'b1',
      chapter_no: '1',
      title: 'Chapter 1',
      sort_no: 1.0,
      page_count: 20,
      views: 500,
      created_at: '2023-06-01T00:00:00Z',
      updated_at: '2023-06-01T00:00:00Z',
      volume_no: null,
      published_on: null,
      internal_release: false,
      optional_data: null,
      groups: [
        { group_id: 'grp1', title: 'ScanGroup', avatar_image_id: 'av1' },
      ],
      uploader: {
        user_id: 'u1',
        username: 'tester',
        avatar_image_id: 'av2',
        class: 'Admin',
      },
    },
  ],

  series_covers: [
    {
      cover_id: 'c1',
      image_id: 'img_cover_001',
      chapter_number: '1',
      volume_number: null,
      language: 'en',
      note: null,
    },
  ],

  series_links: [
    { label: 'Official', url: 'https://example.com/official' },
  ],

  series_staff: [
    { staff_id: 's1', name: 'Author A', role: 'Writer' },
  ],
};

// ──────────────────────────────────────────
// Test cases
// ──────────────────────────────────────────

describe('normalizeSeries()', () => {
  it('parses full series JSON with all fields', () => {
    const series = normalizeSeries(FULL_SERIES_JSON);

    // Primitive fields
    expect(series.seriesId).toBe('12345');
    expect(series.title).toBe('Test Series');
    expect(series.description).toBe('A test series description.');
    expect(series.format).toBe('Manga');
    expect(series.contentRating).toBe('Safe');
    expect(series.publicationStatus).toBe('Ongoing');
    expect(series.uploadStatus).toBe('Active');
    expect(series.originalLanguage).toBe('ja');
    expect(series.translatedLanguage).toBe('en');
    expect(series.titleLanguage).toBe('en');
    expect(series.currentBooks).toBe(42);
    expect(series.totalViews).toBe(1_000_000);
    expect(series.createdAt).toBe('2023-01-01T00:00:00Z');
    expect(series.updatedAt).toBe('2024-01-01T00:00:00Z');
    expect(series.sourceId).toBe('src_001');
    expect(series.trackerId).toBe('trk_001');
    expect(series.averageRating).toBe(4.5);
    expect(series.bayesianRating).toBe(4.2);
    expect(series.totalRatings).toBe(500);
    expect(series.startYear).toBe(2020);
    expect(series.endYear).toBeNull();
    expect(series.currentVolumes).toBe(10);
    expect(series.totalVolumes).toBe(20);
    expect(series.totalBooks).toBe(200);
    expect(series.editionInfo).toBe('First Edition');
    expect(series.distribution).toBe('worldwide');
    expect(series.localCover).toBeNull();

    // Nested arrays
    expect(series.genres).toHaveLength(2);
    expect(series.genres[0].genreId).toBe('g1');
    expect(series.genres[0].genreName).toBe('Action');
    expect(series.genres[0].isSpoiler).toBe(false);
    expect(series.genres[1].isSpoiler).toBe(true);

    expect(series.tags).toHaveLength(1);
    expect(series.tags[0].tagId).toBe('t1');

    expect(series.seriesAlternateTitles).toHaveLength(1);
    expect(series.seriesAlternateTitles[0].label).toBe('Japanese');

    expect(series.seriesBooks).toHaveLength(1);
    expect(series.seriesBooks[0].bookId).toBe('b1');
    expect(series.seriesBooks[0].groups).toHaveLength(1);
    expect(series.seriesBooks[0].groups[0].title).toBe('ScanGroup');

    expect(series.seriesCovers).toHaveLength(1);
    expect(series.seriesCovers[0].coverId).toBe('c1');

    expect(series.seriesLinks).toHaveLength(1);
    expect(series.seriesLinks[0].label).toBe('Official');

    expect(series.seriesStaff).toHaveLength(1);
    expect(series.seriesStaff[0].name).toBe('Author A');

    // coverUrl getter
    expect(series.coverUrl).toBe(`${IMAGE_BASE_URL}/img_cover_001`);
  });

  it('handles empty input with default values', () => {
    const series = normalizeSeries({});

    // String fields
    expect(series.seriesId).toBe('');
    expect(series.title).toBe('');
    expect(series.description).toBe('');

    // Numeric fields
    expect(series.currentBooks).toBe(0);
    expect(series.totalViews).toBe(0);

    // Nullable fields
    expect(series.averageRating).toBeNull();
    expect(series.bayesianRating).toBeNull();
    expect(series.totalRatings).toBeNull();
    expect(series.startYear).toBeNull();
    expect(series.endYear).toBeNull();
    expect(series.editionInfo).toBeNull();
    expect(series.distribution).toBeNull();
    expect(series.localCover).toBeNull();

    // Array fields
    expect(series.genres).toEqual([]);
    expect(series.tags).toEqual([]);
    expect(series.seriesAlternateTitles).toEqual([]);
    expect(series.seriesBooks).toEqual([]);
    expect(series.seriesCovers).toEqual([]);
    expect(series.seriesLinks).toEqual([]);
    expect(series.seriesStaff).toEqual([]);

    // coverUrl getter with no covers
    expect(series.coverUrl).toBe('');
  });

  it('handles class → userClass rename on Uploader', () => {
    const data: Record<string, unknown> = {
      series_id: '1',
      title: 'Test',
      series_books: [
        {
          book_id: 'b1',
          chapter_no: '1',
          title: 'Ch1',
          sort_no: 1,
          page_count: 1,
          views: 1,
          created_at: '',
          updated_at: '',
          groups: [],
          uploader: {
            user_id: 'u1',
            username: 'admin_user',
            avatar_image_id: 'av1',
            class: 'Admin',
          },
        },
      ],
    };

    const series = normalizeSeries(data);
    const uploader = series.seriesBooks[0].uploader;

    expect(uploader).not.toBeNull();
    expect(uploader!.userId).toBe('u1');
    expect(uploader!.username).toBe('admin_user');
    expect(uploader!.userClass).toBe('Admin');
    // Verify the JSON key 'class' was mapped and not left as a direct property
    expect(Object.prototype.hasOwnProperty.call(uploader, 'class')).toBe(false);
  });
});

describe('parseBooks()', () => {
  it('maps packed rows using the fields header', () => {
    const books = parseBooks({
      fields: ['book_id', 'chapter_no', 'title', 'sort_no', 'page_count', 'published_on', 'uploader'],
      books: [
        [
          'b1',
          '5',
          'Chapter 5',
          5.5,
          12,
          '2024-01-01T00:00:00Z',
          { user_id: 'u1', username: 'uploader', avatar_image_id: '', class: 'User' },
        ],
      ],
    });

    expect(books).toHaveLength(1);
    expect(books[0].bookId).toBe('b1');
    expect(books[0].chapterNo).toBe('5');
    expect(books[0].sortNo).toBe(5.5);
    expect(books[0].pageCount).toBe(12);
    expect(books[0].createdAt).toBe('2024-01-01T00:00:00Z');
    expect(books[0].uploader?.userClass).toBe('User');
  });
});

describe('getImageUrl()', () => {
  it('constructs correct image URL from image ID', () => {
    const url = getImageUrl('abc123');
    expect(url).toBe('https://kagane.moe/api/v2/image/abc123');
  });
});

describe('content rating fallback', () => {
  it('uses age_rating when content_rating is absent', () => {
    const series = normalizeSeries({ age_rating: 'Mature' });
    expect(series.contentRating).toBe('Mature');
  });
});
