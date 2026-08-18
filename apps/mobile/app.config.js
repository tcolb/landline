// Variant switch over app.json: APP_VARIANT=dev at prebuild time produces
// the dev-client app ("landline dev", .dev bundle id) that side-installs
// next to the release app and loads JS from a Metro dev server.
module.exports = ({ config }) => {
  if (process.env.APP_VARIANT === "dev") {
    config.name = "landline dev";
    config.ios = { ...config.ios, bundleIdentifier: `${config.ios.bundleIdentifier}.dev` };
    config.android = { ...config.android, package: `${config.android.package}.dev` };
  }
  return config;
};
