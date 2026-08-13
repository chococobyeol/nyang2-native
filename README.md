# 냥냥 Native

기존 냥냥 웹 앱의 UI와 MML 기능을 유지하면서 Windows, macOS, Android, iOS에서 인터넷 연결 없이 실행하도록 만든 Tauri 2 프로젝트입니다.

기존 원본 프로젝트와는 완전히 별개이며, 원본을 실행하거나 수정하지 않습니다. 서버 렌더링과 CDN 런타임 의존성을 제거하고 React 화면, 음원, 이미지, 한국어·일본어·번체 중국어 글꼴을 앱 안에 묶었습니다.

## 구성

- `app/`: React 건반, MML 편집기, 도움말, 로컬 저장 기능
- `public/`: 앱에 포함되는 음원, 테마 이미지, 도움말 이미지
- `src/`: 서버 없이 실행되는 Vite 진입점과 내부 페이지 전환
- `src-tauri/`: 데스크톱·모바일 네이티브 컨테이너와 권한 설정

앱의 연주·편집·자동 저장·사운드팩 기능은 로컬에서 동작합니다. 문의 양식과 이메일 링크를 누를 때만 사용자가 선택한 외부 앱을 엽니다.

## 개발 및 확인

```sh
npm install
npm test
npm run native:dev
```

Node.js 22 이상, Rust와 각 플랫폼 개발 도구가 필요합니다. 모바일 준비 항목은 [Tauri 공식 prerequisites](https://v2.tauri.app/start/prerequisites/)를 따릅니다. 이 작업 환경에서 내려받은 프로젝트 전용 Rust/Android 도구가 있으면 모바일 스크립트가 자동으로 사용하고, 없으면 시스템 도구를 사용합니다.

첫 개발 실행이나 빌드에서는 원본 웹판과 같은 오뮤 다예쁨체를 공식 CDN에서 내려받아 체크섬을 검증한 뒤 앱에 포함합니다. 완성된 앱은 글꼴을 포함한 모든 화면 자산을 로컬에서 읽으며 런타임 네트워크 연결을 요구하지 않습니다.

## 플랫폼 빌드

```sh
# 현재 운영체제용 데스크톱 설치 앱
npm run native:build

# macOS .app만 생성
npm run macos:build

# Android ARM64 APK
npm run android:build:arm64

# iOS (macOS와 Xcode 필요)
npm run ios:build

# 서명이 필요 없는 iPhone Simulator 앱
npm run ios:build:simulator
```

Windows 설치 프로그램은 Windows 환경 또는 `.github/workflows/windows-build.yml`에서 NSIS 설치 EXE로 빌드합니다. macOS와 iOS 앱은 macOS/Xcode 환경에서 빌드합니다. 앱스토어·Google Play·공개 macOS 배포에는 각 플랫폼의 개발자 계정, 배포용 코드 서명과 공증이 필요합니다. 자세한 배포 단계는 [Tauri 공식 배포 문서](https://v2.tauri.app/distribute/)를 참고하세요.

이번 검증에서 만든 설치·실행 파일은 `artifacts/`에 있습니다. 이 파일들의 서명 범위는 `artifacts/README.md`에 구분해 두었습니다.

## 데이터와 파일

- 설정, 마지막 MML 프로젝트, 사운드팩은 각 플랫폼 WebView의 로컬 저장소에 보관됩니다.
- MIDI, MML, 냥냥 프로젝트 내보내기는 네이티브 저장 대화상자를 사용합니다.
- 앱을 제거하면 로컬 데이터도 삭제될 수 있으므로 중요한 곡은 프로젝트 파일로 내보내 보관하세요.
