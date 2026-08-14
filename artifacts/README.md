# 검증 산출물

- `macos/냥냥_1.0.0_aarch64.dmg`: Apple Silicon macOS 설치 이미지. 로컬 임시 서명으로 무결성을 확인했으며 공증 전 파일입니다.
- `macos/냥냥_1.0.1_aarch64.dmg`: 900px 가로 화면의 상단 조작부 잘림을 수정한 Apple Silicon macOS 설치 이미지. 공증 전 파일입니다.
- `windows/냥냥_1.0.0_x64-setup.exe`: 기존 Windows x64 설치 파일입니다. Windows 환경에서 1.0.1을 다시 빌드하기 전까지 보존합니다.
- `macos/냥냥.app`: 위 설치 이미지에 든 macOS 앱입니다.
- `android/nyangnyang-1.0.0-arm64-release.apk`: Android 7.0 이상 ARM64용 최적화 APK. 로컬 설치 확인용 테스트 키로 서명했습니다.
- `android/nyangnyang-1.0.0-arm64-release-unsigned.apk`: 사용자의 정식 배포 키로 서명할 릴리스 APK입니다.
- `android/nyangnyang-1.0.0-arm64-debug.apk`: 개발·디버깅용 APK입니다.
- `ios-simulator/냥냥.app`: Apple Silicon Mac의 iPhone Simulator용 앱이며 실제 iPhone 설치 파일은 아닙니다.
- `ios-simulator/냥냥_1.0.0_arm64_simulator.zip`: 위 Simulator 앱을 전달하기 위한 압축 파일입니다.
- `ios-simulator/ios-simulator.png`: iPhone 17 시뮬레이터 실제 실행 확인 화면입니다.

App Store, Google Play, Microsoft Store 또는 외부 macOS 배포 전에는 각 플랫폼 개발자 계정의 배포용 서명 절차가 필요합니다.
