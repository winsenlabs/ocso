import type { MetadataRoute } from 'next';
import { siteUrl } from '@/content/links';

/** The home page and the thesis; the home page's sections are anchors, which do not belong in a sitemap. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${siteUrl}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${siteUrl}/thesis`, changeFrequency: 'monthly', priority: 0.8 },
  ];
}
