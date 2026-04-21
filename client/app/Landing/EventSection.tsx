import Image from "next/image";

const sampleEvents = [
  {
    id: 1,
    name: "Pokemon Beginner Tournament",
    image:
      "https://api.builder.io/api/v1/image/assets/TEMP/dcbc8750dcd8a262d13a8bb7e0765172ceec3e3d?width=734",
  },
  {
    id: 2,
    name: "Pokemon Beginner Tournament",
    image:
      "https://api.builder.io/api/v1/image/assets/TEMP/dcbc8750dcd8a262d13a8bb7e0765172ceec3e3d?width=734",
  },
  {
    id: 3,
    name: "Pokemon Beginner Tournament",
    image:
      "https://api.builder.io/api/v1/image/assets/TEMP/dcbc8750dcd8a262d13a8bb7e0765172ceec3e3d?width=734",
  },
  {
    id: 4,
    name: "Pokemon Beginner Tournament",
    image:
      "https://api.builder.io/api/v1/image/assets/TEMP/dcbc8750dcd8a262d13a8bb7e0765172ceec3e3d?width=734",
  },
  {
    id: 5,
    name: "Pokemon Beginner Tournament",
    image:
      "https://api.builder.io/api/v1/image/assets/TEMP/dcbc8750dcd8a262d13a8bb7e0765172ceec3e3d?width=734",
  },
];

export default function EventsSection() {
  return (
    <section
      className="w-full flex flex-col gap-10 md:gap-16"
      style={{
        background: "linear-gradient(180deg, #1B1B1B 5.58%, #0F0F0F 35.73%)",
      }}
    >
      {/* Header */}
      <div className="pt-12 md:pt-20 px-6 md:px-12">
        <h2 className="font-poppins font-extrabold text-white text-3xl md:text-5xl lg:text-[64px]">
          Upcoming Events
        </h2>
      </div>

      {/* Events Container */}
      <div className="flex flex-col lg:flex-row gap-8 px-6 md:px-12 pb-16 md:pb-24 items-start justify-between">
        {/* Featured Event */}
        <div
          className="w-full lg:w-[48%] xl:max-w-[845px] rounded-[20px] border-[6px] border-[#3E9434] flex flex-col overflow-hidden shrink-0"
          style={{
            background:
              "radial-gradient(63.86% 63.86% at 50% 50%, #52B946 0%, #3E9434 100%)",
          }}
        >
          {/* Featured Image */}
          <div className="relative w-full aspect-[4/3]">
            <Image
              src="https://api.builder.io/api/v1/image/assets/TEMP/c0d1ff89c4da935e765522869970efa4da16f524?width=1690"
              alt="Featured Event"
              fill
              className="object-cover rounded-t-[14px]"
              unoptimized
            />
          </div>

          {/* Event Name */}
          <div className="flex justify-center items-center px-6 py-4 md:py-6">
            <h3 className="font-poppins font-extrabold text-white text-center text-lg sm:text-2xl md:text-3xl lg:text-4xl leading-tight">
              Hobby+ Open &amp; Junior B4 Tournament
            </h3>
          </div>

          {/* Event Details */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 px-5 py-4 md:py-5">
            {/* Left: Location, Slots, Time */}
            <div className="flex flex-col gap-2 flex-1">
              {/* Location */}
              <div className="flex items-center gap-2">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 28 28"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="shrink-0"
                >
                  <path
                    d="M14 13.9999C14.6417 13.9999 15.191 13.7714 15.6479 13.3145C16.1049 12.8576 16.3333 12.3083 16.3333 11.6666C16.3333 11.0249 16.1049 10.4756 15.6479 10.0187C15.191 9.56172 14.6417 9.33325 14 9.33325C13.3583 9.33325 12.809 9.56172 12.3521 10.0187C11.8951 10.4756 11.6667 11.0249 11.6667 11.6666C11.6667 12.3083 11.8951 12.8576 12.3521 13.3145C12.809 13.7714 13.3583 13.9999 14 13.9999ZM14 22.5749C16.3722 20.3971 18.1319 18.4187 19.2792 16.6395C20.4264 14.8603 21 13.2805 21 11.8999C21 9.78047 20.3243 8.04506 18.9729 6.69367C17.6215 5.34228 15.9639 4.66659 14 4.66659C12.0361 4.66659 10.3785 5.34228 9.02709 6.69367C7.6757 8.04506 7.00001 9.78047 7.00001 11.8999C7.00001 13.2805 7.57362 14.8603 8.72084 16.6395C9.86806 18.4187 11.6278 20.3971 14 22.5749ZM14 25.6666C10.8694 23.0027 8.53126 20.5284 6.98542 18.2437C5.43959 15.9589 4.66667 13.8444 4.66667 11.8999C4.66667 8.98325 5.60487 6.65964 7.48126 4.92909C9.35764 3.19853 11.5306 2.33325 14 2.33325C16.4694 2.33325 18.6424 3.19853 20.5188 4.92909C22.3951 6.65964 23.3333 8.98325 23.3333 11.8999C23.3333 13.8444 22.5604 15.9589 21.0146 18.2437C19.4688 20.5284 17.1306 23.0027 14 25.6666Z"
                    fill="white"
                  />
                </svg>
                <span className="font-questrial text-white text-base md:text-xl lg:text-2xl">
                  Activo Fitness
                </span>
              </div>

              {/* Slots */}
              <div className="flex items-center gap-2">
                <div className="relative w-6 h-6 shrink-0">
                  <Image
                    src="https://api.builder.io/api/v1/image/assets/TEMP/9a8ef1524467c6b9fd4ce2a7ac24574826eab049?width=64"
                    alt="Ticket"
                    fill
                    className="object-contain"
                    unoptimized
                  />
                </div>
                <span className="font-questrial text-white text-base md:text-xl lg:text-2xl">
                  Free Entry 32/50 Slots
                </span>
              </div>

              {/* Time */}
              <div className="flex items-center gap-2">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 32 32"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="shrink-0"
                >
                  <path
                    d="M21.3333 2.66675V8.00008M10.6667 2.66675V8.00008M4 13.3334H28M6.66667 5.33341H25.3333C26.8061 5.33341 28 6.52732 28 8.00008V26.6667C28 28.1395 26.8061 29.3334 25.3333 29.3334H6.66667C5.19391 29.3334 4 28.1395 4 26.6667V8.00008C4 6.52732 5.19391 5.33341 6.66667 5.33341Z"
                    stroke="white"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="font-questrial text-white text-base md:text-xl lg:text-2xl">
                  1 Hour Remaining
                </span>
              </div>
            </div>

            {/* Right: Prize */}
            <div className="flex items-end gap-3">
              <div className="relative w-14 h-14 md:w-20 md:h-20 shrink-0">
                <Image
                  src="https://api.builder.io/api/v1/image/assets/TEMP/a11b31821fa0e4b782bc34eaf7bd5d9871b425de?width=200"
                  alt="Trophy"
                  fill
                  className="object-contain"
                  unoptimized
                />
              </div>
              <p className="font-questrial text-white text-sm md:text-base lg:text-xl leading-snug max-w-[200px] md:max-w-[260px]">
                CX-00 B4 EXCLUSIVE BEYBLADE X PERSEUS DARK GOLD 6-80W
              </p>
            </div>
          </div>
        </div>

        {/* Event List */}
        <div className="flex flex-col gap-5 w-full lg:flex-1">
          {sampleEvents.map((event) => (
            <div
              key={event.id}
              className="flex items-center gap-3 rounded-[20px] border-b-4 border-[#52B946] overflow-hidden"
              style={{
                background: "linear-gradient(90deg, #2F2F2F 0%, #575757 134.98%)",
              }}
            >
              <div className="flex-1 flex items-center justify-center px-4 py-4 md:py-6">
                <h4 className="font-poppins font-bold text-white text-center text-base sm:text-lg md:text-2xl lg:text-3xl leading-snug">
                  {event.name}
                </h4>
              </div>
              <div className="relative w-[100px] sm:w-[140px] md:w-[200px] lg:w-[240px] h-[80px] sm:h-[100px] md:h-[140px] lg:h-[160px] shrink-0">
                <Image
                  src={event.image}
                  alt={event.name}
                  fill
                  className="object-cover rounded-r-[16px]"
                  unoptimized
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}