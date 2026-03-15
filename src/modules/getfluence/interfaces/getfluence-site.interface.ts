/**
 * Interfaces for Getfluence site data
 */

export interface GetfluenceSiteRaw {
  // Core info
  domain: string;
  url: string;

  // SEO metrics
  tf?: number; // Trust Flow
  cf?: number; // Citation Flow
  da?: number; // Domain Authority
  dr?: number; // Domain Rating

  // Traffic metrics
  traffic?: number;
  keywords?: number;

  // Backlinks
  backlinks?: number;
  refDomains?: number;

  // Pricing
  price?: number;

  // Category
  category?: string;
  language?: string;
  country?: string;

  // Other info
  doFollow?: boolean;

  [key: string]: any; // Allow additional fields
}

export interface GetfluenceSite {
  // Core fields
  name: string;
  provider: string;

  // Domain information
  domain?: string;
  url?: string;

  // Pricing
  price?: number;

  // Traffic and SEO metrics
  traffic?: number;
  tf?: number;
  cf?: number;
  da?: number;
  dr?: number;
  domain_ref?: number;
  bl?: number;
  keywords?: number;

  // Category
  category?: string;

  // Generated fields
  link_ahref: string;
  entry_date: string;

  // BQS scoring fields (optional)
  bqs_score?: number;
  bqs_score_info?: {
    bqs_quality_tier?: string;
    bqs_authority?: number;
    bqs_consistency_penalty?: number;
    bqs_passed_filter?: boolean;
    bqs_filter_reason?: string;
    bqs_roi?: number;
  };
}

export interface GetfluenceCategory {
  id: string;
  name: string;
  slug?: string;
}
