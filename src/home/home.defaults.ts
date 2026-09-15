/**
 * The landing page as it ships (docs/home-blocks-plan.md).
 *
 * These are the values the migration seeds, and the values `HomeService` falls
 * back to for any block whose row is missing — so a database that has never
 * been migrated, or a row somebody deleted by hand, still renders a complete
 * page instead of a blank one. The frontend components keep their own prop
 * defaults for the case where the API cannot be reached at all (Core Rule 8).
 */

export const HOME_BLOCK_KEYS = ['hero', 'shop', 'tournaments'] as const;
export type HomeBlockKey = (typeof HOME_BLOCK_KEYS)[number];

export interface HeroSlide {
  image: string;
  title?: string;
  photoDesc?: string;
}

export interface HeroStoreButton {
  text?: string;
  href: string;
  color?: string;
  iconUrl?: string;
  /** Logo size inside the button. Uploaded storefront logos carry wildly
   *  different padding, so one fixed box always crops or strands one of them. */
  iconScale?: number;
}

export interface HeroContent {
  description?: string;
  slides?: HeroSlide[];
  storeButtons?: HeroStoreButton[];
}

export interface SectionContent {
  label?: string;
}

export type HomeBlockContent = Record<string, unknown>;

export interface HomeBlockView {
  key: string;
  order: number;
  visible: boolean;
  content: HomeBlockContent;
}

export const HOME_DEFAULTS: Record<HomeBlockKey, HomeBlockView> = {
  hero: {
    key: 'hero',
    order: 0,
    visible: true,
    content: {
      description:
        'Experience the next level of hobby gaming. Professional tournaments, high-fidelity community, and the best gear, all in one place.',
      slides: [],
      storeButtons: [
        {
          text: '',
          href: 'https://shopee.ph/hobbyplusshop',
          color: '#FFFFFF',
          iconUrl: '/shp.png',
          iconScale: 1,
        },
        {
          text: '',
          href: 'https://www.lazada.com.ph/shop/hobby-plus-shop',
          color: '#FFFFFF',
          iconUrl: '/laz.png',
          iconScale: 1.3,
        },
      ],
    } satisfies HeroContent as HomeBlockContent,
  },
  shop: {
    key: 'shop',
    order: 1,
    visible: true,
    content: { label: 'STORE' } satisfies SectionContent as HomeBlockContent,
  },
  tournaments: {
    key: 'tournaments',
    order: 2,
    visible: true,
    content: {
      label: 'TOURNAMENTS',
    } satisfies SectionContent as HomeBlockContent,
  },
};

export function isHomeBlockKey(key: string): key is HomeBlockKey {
  return (HOME_BLOCK_KEYS as readonly string[]).includes(key);
}
