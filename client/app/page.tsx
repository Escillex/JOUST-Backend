import NavBar from "./Landing/NavBar";
import HeroSection from "./Landing/HeroSection";
import EventSection from "./Landing/EventSection";
import ShopPreview from "./Landing/ShopPreview";
import Footer from "./Landing/Footer";

export default function Main() {
  return (
    <main>
      <NavBar />
      <HeroSection />
      <EventSection />
      <ShopPreview />
      <Footer />
    </main>
  );
}