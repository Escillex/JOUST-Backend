import Image from "next/image";
import Link from "next/link";

export default function HeroSection() {
  return (
    <section
      className="relative w-full min-h-[500px] md:min-h-[700px] lg:h-screen flex items-end"
      style={{
        background: `
          linear-gradient(90deg, rgba(0,0,0,0.10) 0%, rgba(102,102,102,0.00) 100%),
          linear-gradient(180deg, rgba(82,185,70,0.10) 0%, rgba(102,102,102,0.00) 29.54%),
          linear-gradient(0deg, rgba(0,0,0,0.40) 0%, rgba(0,0,0,0.40) 100%),
          url('https://api.builder.io/api/v1/image/assets/TEMP/c58845722dd0b107ab3a18c2927d6ea5222f274d?width=3840') center / cover no-repeat
        `,
      }}
    >
      <div className="w-full max-w-[60rem] px-6 md:px-16 pb-10 md:pb-16 lg:pb-[134px] flex flex-col items-start gap-4 md:gap-6">
        {/* Logo */}
        <div className="relative w-[220px] md:w-[350px] lg:w-[480px] h-auto">
          <Image
            src="https://api.builder.io/api/v1/image/assets/TEMP/1d8874a63316659a844d100377fcaeebc6828b37?width=1170"
            alt="Hobby+ Logo"
            width={480}
            height={160}
            className="w-full h-auto"
            unoptimized
          />
        </div>

        {/* Tagline */}
        <h1 className="font-poppins font-extrabold text-white text-2xl sm:text-3xl md:text-4xl lg:text-5xl xl:text-[64px] leading-tight max-w-2xl">
          One Stop Shop for all your Hobby needs
        </h1>

        {/* CTA Buttons */}
        <div className="flex flex-wrap gap-4 mt-2">
          {/* Shopee */}
          <Link
            href="https://shopee.ph"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-6 py-3 rounded-[30px] bg-[#EA501F] text-white font-questrial text-xl md:text-2xl hover:opacity-90 transition-opacity"
          >
            <div className="relative w-6 h-6">
              <Image
                src="https://api.builder.io/api/v1/image/assets/TEMP/da4fbe17447616c2816335aef3bddd79a5c39dbf?width=58"
                alt="Shopee"
                fill
                className="object-contain"
                unoptimized
              />
            </div>
            Shopee
          </Link>

          {/* Lazada */}
          <Link
            href="https://lazada.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-6 py-3 rounded-[30px] bg-[#0F1472] text-white font-questrial text-xl md:text-2xl hover:opacity-90 transition-opacity"
          >
            <div className="relative w-7 h-7">
              <Image
                src="https://api.builder.io/api/v1/image/assets/TEMP/bb159fb128d2c596fd1e982da6c6dd99bf91a919?width=68"
                alt="Lazada"
                fill
                className="object-contain"
                unoptimized
              />
            </div>
            Lazada
          </Link>
        </div>
      </div>
    </section>
  );
}