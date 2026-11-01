// Extends app.json with native build settings.
//  - The speech library's native code (libsherpa-onnx-jni) looks up the fields of its Kotlin config classes by
//    name. A release build's code shrinker (R8) removes or renames fields that Kotlin never reads, and the model
//    then fails to load with "Failed to get field ID for decodingMethod". So keep that package untouched, and
//    do not minify release builds.
//  - A "test" build (eas.json) sets ALLOW_CLEARTEXT=1 so the installed app can reach a plain http:// server on a
//    laptop over Wi-Fi: Android blocks http from release builds unless this is on. Preview and production builds
//    leave it off and need an https:// server (the deployed URL).
module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins ?? []),
    [
      'expo-build-properties',
      {
        android: {
          enableMinifyInReleaseBuilds: false,
          enableShrinkResourcesInReleaseBuilds: false,
          extraProguardRules: '-keep class com.k2fsa.sherpa.onnx.** { *; }\n-keepclassmembers class com.k2fsa.sherpa.onnx.** { *; }',
          ...(process.env.ALLOW_CLEARTEXT === '1' ? { usesCleartextTraffic: true } : {}),
        },
      },
    ],
  ],
});
