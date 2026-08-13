import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/yomogi/japanese-400.css";
import "@fontsource/yomogi/latin-400.css";
import "@fontsource/iansui/chinese-traditional-400.css";
import "@fontsource/iansui/latin-400.css";
import Home from "../app/page";
import HelpPage from "../app/help/page";
import PrivacyPage from "../app/privacy/page";
import { LocaleProvider } from "../app/i18n";
import { openExternalUrl } from "../app/native-platform";
import "../app/globals.css";

type AppPage = "home" | "help" | "privacy";

function currentPage(): AppPage {
  const page = new URLSearchParams(window.location.search).get("page");
  return page === "help" || page === "privacy" ? page : "home";
}

function App() {
  const [page, setPage] = useState<AppPage>(currentPage);

  useEffect(() => {
    const updatePage = () => {
      setPage(currentPage());
      window.scrollTo({ top: 0, behavior: "instant" });
    };
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";

      if (anchor.dataset.appRoute !== undefined) {
        event.preventDefault();
        window.history.pushState(null, "", href);
        updatePage();
        return;
      }

      if (/^(https?:|mailto:|tel:)/i.test(href)) {
        event.preventDefault();
        void openExternalUrl(href);
      }
    };

    window.addEventListener("popstate", updatePage);
    document.addEventListener("click", handleClick);
    return () => {
      window.removeEventListener("popstate", updatePage);
      document.removeEventListener("click", handleClick);
    };
  }, []);

  return page === "help" ? <HelpPage /> : page === "privacy" ? <PrivacyPage /> : <Home />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
);
