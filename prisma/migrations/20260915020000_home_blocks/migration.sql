-- Home page blocks (docs/home-blocks-plan.md). The landing page's sections
-- become rows: each one can be reordered, hidden and — the point of the whole
-- change — have its text edited, instead of the copy living in JSX.
--
-- Seeded with exactly what the components hardcode today, so the public page
-- looks identical the moment this lands. The hero's slides are carried over
-- from the site assets the old page read directly ("hero_slide_1", ...), with
-- the same generated title and side label, so no slide is lost either.
CREATE TABLE "HomeBlock" (
  "key"       TEXT NOT NULL,
  "order"     INTEGER NOT NULL,
  "visible"   BOOLEAN NOT NULL DEFAULT true,
  "content"   JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "HomeBlock_pkey" PRIMARY KEY ("key")
);

INSERT INTO "HomeBlock" ("key", "order", "visible", "content", "updatedAt")
VALUES (
  'hero',
  0,
  true,
  jsonb_build_object(
    'description',
    'Experience the next level of hobby gaming. Professional tournaments, high-fidelity community, and the best gear, all in one place.',
    'slides',
    COALESCE(
      (
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'image', a."url",
                   'title', 'LIVE EVENT CYCLE',
                   'photoDesc', upper(a."key")
                 )
                 ORDER BY a."key"
               )
        FROM "SiteAsset" a
        WHERE a."key" LIKE 'hero_slide_%'
      ),
      '[]'::jsonb
    ),
    'storeButtons',
    jsonb_build_array(
      jsonb_build_object('text', '', 'href', 'https://shopee.ph/hobbyplusshop', 'color', '#FFFFFF', 'iconUrl', '/shp.png', 'iconScale', 1),
      jsonb_build_object('text', '', 'href', 'https://www.lazada.com.ph/shop/hobby-plus-shop', 'color', '#FFFFFF', 'iconUrl', '/laz.png', 'iconScale', 1.3)
    )
  ),
  NOW()
), (
  'shop',
  1,
  true,
  jsonb_build_object('label', 'STORE'),
  NOW()
), (
  'tournaments',
  2,
  true,
  jsonb_build_object('label', 'TOURNAMENTS'),
  NOW()
);
