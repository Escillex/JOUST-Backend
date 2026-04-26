"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export default function Navbar() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const navLinks = [
    { label: "Home", href: "/" },
    { label: "Tournaments", href: "/join_tournament" },
    { label: "Rankings", href: "/rankings" },
  ];

  return (
    <nav className="w-full bg-[#1B1B1B] h-17.5 flex items-center px-3 md:px-12 gap-4 z-50 sticky top-0">
      {/* Logo */}
      <Link href="/" className="flex items-center shrink-0 h-full px-2">
        <div className="relative h-7 w-34.5">
          <Image
            src="https://api.builder.io/api/v1/image/assets/TEMP/acefcd35d1741c1bba2b097e2b3f77c39dc917b8?width=276"
            alt="Hobby+ Logo"
            fill
            className="object-contain"
            unoptimized
          />
        </div>
      </Link>

      {/* Desktop Nav Links */}
      <div className="hidden md:flex items-end gap-4 flex-1">
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`font-poppins font-bold text-xl lg:text-2xl transition-colors ${
              pathname === link.href
                ? "text-white"
                : "text-[#838383] hover:text-white"
            }`}
          >
            {link.label}
          </Link>
        ))}
      </div>

      {/* Mobile spacer */}
      <div className="flex-1 md:hidden" />

      {/* Sign In Button */}
      <Link
        href="/Auth"
        className="hidden md:flex items-center justify-center px-5 py-2 rounded-[20px] bg-[#52B946] text-black font-questrial text-sm shrink-0 hover:bg-[#3E9434] transition-colors"
      >
        Sign in
      </Link>

      {/* Mobile Menu Button */}
      <button
        className="md:hidden flex flex-col gap-1.5 p-2"
        onClick={() => setMenuOpen(!menuOpen)}
        aria-label="Toggle menu"
      >
        <span
          className={`block w-6 h-0.5 bg-white transition-all ${menuOpen ? "rotate-45 translate-y-2" : ""}`}
        />
        <span
          className={`block w-6 h-0.5 bg-white transition-all ${menuOpen ? "opacity-0" : ""}`}
        />
        <span
          className={`block w-6 h-0.5 bg-white transition-all ${menuOpen ? "-rotate-45 -translate-y-2" : ""}`}
        />
      </button>

      {/* Mobile Dropdown */}
      {menuOpen && (
        <div className="absolute top-17.5 left-0 right-0 bg-[#1B1B1B] border-t border-[#2F2F2F] flex flex-col p-4 gap-4 md:hidden z-50">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className={`font-poppins font-bold text-xl transition-colors ${
                pathname === link.href ? "text-white" : "text-[#838383]"
              }`}
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/Auth"
            onClick={() => setMenuOpen(false)}
            className="inline-flex items-center justify-center px-5 py-2 rounded-[20px] bg-[#52B946] text-black font-questrial text-sm w-fit hover:bg-[#3E9434] transition-colors"
          >
            Sign in
          </Link>
        </div>
      )}
    </nav>
  );
}