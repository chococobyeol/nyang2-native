"use client";

import { useEffect, useMemo } from "react";
import { Translated, useI18n } from "../i18n";

const EFFECTIVE_DATE = new Date(Date.UTC(2026, 7, 1));

export default function PrivacyPage() {
  const { brandName, locale, t } = useI18n();
  const effectiveDate = useMemo(() => new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "Asia/Seoul",
  }).format(EFFECTIVE_DATE), [locale]);

  useEffect(() => {
    document.title = `${t("개인정보처리방침")} | ${brandName}`;
  }, [brandName, t]);

  return (
    <Translated><main className="privacy-page">
      <article className="privacy-card">
        <header className="privacy-header">
          <a className="privacy-brand" href="./" data-app-route aria-label={t("{brand} 건반으로 돌아가기", { brand: brandName })}>
            <img src="/assets/themes/default/pawpad.svg" alt="" width={39} height={39} />
            <strong>{brandName}</strong>
          </a>
          <a className="privacy-back" href="./" data-app-route>← 건반으로 돌아가기</a>
        </header>

        <div className="privacy-title">
          <span>PRIVACY</span>
          <h1>개인정보처리방침</h1>
          <p>{t("시행일 {date}", { date: effectiveDate })}</p>
        </div>

        <section className="privacy-summary" aria-label={t("핵심 요약")}>
          <strong>한눈에 보기</strong>
          <p>냥냥은 회원가입, 맞춤형 광고, 이용자별 행동 추적 기능을 사용하지 않으며 이용자의 개인정보를 직접 수집하지 않습니다.</p>
        </section>

        <div className="privacy-sections">
          <section>
            <span>01</span>
            <div>
              <h2>직접 수집하는 정보</h2>
              <p>냥냥은 이름, 이메일, 전화번호, 계정 정보와 같은 개인정보를 직접 입력받거나 저장하지 않습니다. 자체 쿠키와 맞춤형 광고도 사용하지 않습니다.</p>
            </div>
          </section>

          <section>
            <span>02</span>
            <div>
              <h2>기기에 저장되는 설정</h2>
              <p>옥타브 버튼, 건반 수, 키 매핑, 표시 방식, 음색과 음량 등의 설정, 마지막 MML 프로젝트·편집 기록과 사용자가 추가한 사운드팩은 브라우저의 기기 저장 공간에만 보관됩니다. 이 정보는 서버로 전송되지 않으며, 설정 초기화, 사운드팩 삭제 또는 브라우저의 사이트 데이터 삭제 기능으로 지울 수 있습니다.</p>
            </div>
          </section>

          <section>
            <span>03</span>
            <div>
              <h2>오프라인 실행과 외부 링크</h2>
              <p>앱의 연주, 편집, 저장 기능은 인터넷 연결 없이 기기 안에서 동작합니다. 문의 양식이나 이메일 주소처럼 외부 링크를 직접 선택하면 시스템 브라우저 또는 메일 앱이 열리며, 이후의 정보 처리는 해당 외부 서비스의 방침을 따릅니다.</p>
            </div>
          </section>

          <section>
            <span>04</span>
            <div>
              <h2>보유 기간과 이용자의 선택</h2>
              <p>냥냥이 별도로 보유하는 개인정보는 없습니다. 기기에 저장된 설정은 이용자가 삭제할 때까지 남을 수 있으며, 설정 초기화나 브라우저의 사이트 데이터 삭제 기능으로 언제든 지울 수 있습니다.</p>
            </div>
          </section>

          <section>
            <span>05</span>
            <div>
              <h2>문의와 방침 변경</h2>
              <p>개인정보 처리와 관련된 문의는 아래 이메일로 보내주세요. 방침의 내용이 달라지면 이 페이지의 시행일과 함께 변경 사항을 알립니다.</p>
              <p><a href="mailto:chaamu.channel@gmail.com">chaamu.channel@gmail.com</a></p>
            </div>
          </section>
        </div>

        <footer className="privacy-footer">
          <span>{brandName}</span>
          <a href="./" data-app-route>연주 화면으로 돌아가기</a>
        </footer>
      </article>
    </main></Translated>
  );
}
