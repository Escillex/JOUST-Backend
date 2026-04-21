"use client";

import Image from "next/image";
import { useState } from "react";

const products = [
  {
    name: "Bandai Mega Man X Chogokin Mega Man X",
    images: [
      "https://api.builder.io/api/v1/image/assets/TEMP/9ab595ead1e5d23a0f596f249c15d2358b66ad82?width=1788",
      "https://api.builder.io/api/v1/image/assets/TEMP/d213b0bcf1a2691fe290b5fb8cd330af6f82bdb2?width=1138",
      "https://api.builder.io/api/v1/image/assets/TEMP/2eea7c61ee84cb3f74167833ed2690d78d1c02ac?width=1136",
    ],
  },
];

export default function ShopPreview() {
  const [current, setCurrent] = useState(0);
  const product = products[0];
  const total = product.images.length;

  const prev = () => setCurrent((c) => (c - 1 + total) % total);
  const next = () => setCurrent((c) => (c + 1) % total);

  const prevIdx = (current - 1 + total) % total;
  const nextIdx = (current + 1) % total;

  return (
    <section className="w-full bg-[#1B1B1B] flex flex-col items-center">
      {/* Header */}
      <div className="w-full border-t border-[#797979] bg-[#242424] shadow-[0_4px_8px_0_rgba(0,0,0,0.25)] px-6 md:px-12">
        <h2 className="font-poppins font-extrabold text-white text-3xl md:text-5xl lg:text-[64px] py-2 md:py-4">
          Products:
        </h2>
      </div>

      {/* Carousel */}
      <div className="w-full flex items-center justify-center gap-4 md:gap-8 px-4 md:px-12 pt-10 md:pt-16 overflow-hidden">
        {/* Side image left */}
        <div className="hidden md:block shrink-0 opacity-60 relative w-[200px] lg:w-[340px] xl:w-[450px] aspect-square">
          <Image
            src={product.images[prevIdx]}
            alt="Previous product"
            fill
            className="object-contain"
            unoptimized
          />
        </div>

        {/* Left Arrow */}
        <button
          onClick={prev}
          className="shrink-0 hover:opacity-70 transition-opacity"
          aria-label="Previous product"
        >
          <svg
            width="60"
            height="60"
            viewBox="0 0 87 87"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="md:w-[87px] md:h-[87px]"
          >
            <path
              d="M43.5 29L29 43.5M29 43.5L43.5 58M29 43.5H58M79.75 43.5C79.75 63.5203 63.5203 79.75 43.5 79.75C23.4797 79.75 7.25 63.5203 7.25 43.5C7.25 23.4797 23.4797 7.25 43.5 7.25C63.5203 7.25 79.75 23.4797 79.75 43.5Z"
              stroke="white"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {/* Center image */}
        <div className="relative shrink-0 w-[240px] sm:w-[320px] md:w-[500px] lg:w-[650px] xl:w-[750px] aspect-square">
          <Image
            src={product.images[current]}
            alt={product.name}
            fill
            className="object-contain"
            unoptimized
          />
        </div>

        {/* Right Arrow */}
        <button
          onClick={next}
          className="shrink-0 hover:opacity-70 transition-opacity"
          aria-label="Next product"
        >
          <svg
            width="60"
            height="60"
            viewBox="0 0 88 88"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="md:w-[88px] md:h-[88px]"
          >
            <path
              d="M43.5149 58.0111L58.0112 43.5074M58.0112 43.5074L43.5075 29.0111M58.0112 43.5074L29.0112 43.5148M7.26118 43.5204C7.25605 23.5001 23.4816 7.26626 43.5019 7.26112C63.5222 7.25599 79.756 23.4815 79.7612 43.5018C79.7663 63.5221 63.5408 79.756 43.5205 79.7611C23.5002 79.7663 7.26631 63.5407 7.26118 43.5204Z"
              stroke="white"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {/* Side image right */}
        <div className="hidden md:block shrink-0 opacity-60 relative w-[200px] lg:w-[340px] xl:w-[450px] aspect-square">
          <Image
            src={product.images[nextIdx]}
            alt="Next product"
            fill
            className="object-contain"
            unoptimized
          />
        </div>
      </div>

      {/* Product Name */}
      <div className="w-full flex items-center justify-center px-6 pt-6 pb-10 md:pb-14">
        <h3 className="font-poppins font-extrabold text-white text-xl sm:text-2xl md:text-4xl lg:text-[48px] xl:text-[64px] text-center leading-tight max-w-4xl">
          {product.name}
        </h3>
      </div>
    </section>
  );
}