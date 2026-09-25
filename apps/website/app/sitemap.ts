import type { MetadataRoute } from 'next';
import { siteUrl } from '@/content/links';

/** One page; its sections are anchors, which do not belong in a sitemap. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${siteUrl}/`, changeFrequency: 'weekly', priority: 1 }];
}
