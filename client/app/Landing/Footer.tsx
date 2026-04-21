import Link from "next/link";

export default function Footer() {
  return (
    <footer className="w-full border-t-4 border-[#2F2F2F] bg-[#1B1B1B]">
      <div className="flex flex-wrap gap-8 md:gap-16 lg:gap-24 px-6 md:px-16 lg:px-24 py-6 md:py-8">
        {/* Contact Info */}
        <div className="flex flex-col gap-2">
          <span className="font-questrial text-[#838383] text-base md:text-lg">
            Contact no:
          </span>
          <span className="font-questrial text-[#838383] text-base md:text-lg">
            Email:
          </span>
          <Link
            href="https://facebook.com"
            target="_blank"
            rel="noopener noreferrer"
            className="font-questrial text-[#838383] text-base md:text-lg hover:text-white transition-colors"
          >
            Facebook
          </Link>
        </div>

        {/* Shop Links */}
        <div className="flex flex-col gap-2 items-center">
          <Link
            href="https://lazada.com"
            target="_blank"
            rel="noopener noreferrer"
            className="font-questrial text-[#838383] text-base md:text-lg hover:text-white transition-colors"
          >
            Lazada
          </Link>
          <Link
            href="https://shopee.ph"
            target="_blank"
            rel="noopener noreferrer"
            className="font-questrial text-[#838383] text-base md:text-lg hover:text-white transition-colors"
          >
            Shoppee
          </Link>
        </div>

        {/* Location */}
        <div className="flex items-center justify-center px-2 py-2">
          <Link
            href="#"
            className="font-questrial text-[#838383] text-base md:text-lg hover:text-white transition-colors"
          >
            Location
          </Link>
        </div>
      </div>
    </footer>
  );
}