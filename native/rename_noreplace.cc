#include <node_api.h>

#include <cerrno>
#include <string>

#if defined(_WIN32)
#include <windows.h>
#elif defined(__linux__)
#include <fcntl.h>
#include <sys/syscall.h>
#include <unistd.h>
#elif defined(__APPLE__)
#include <stdio.h>
#endif

namespace {

void ThrowSystemError(napi_env env, const char* code, const char* message) {
  napi_value message_value;
  napi_value error;
  napi_value code_value;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value);
  napi_create_error(env, nullptr, message_value, &error);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_set_named_property(env, error, "code", code_value);
  napi_throw(env, error);
}

bool ReadString(napi_env env, napi_value value, std::string* result) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    return false;
  }
  result->resize(length + 1);
  size_t copied = 0;
  const napi_status status = napi_get_value_string_utf8(
      env, value, result->data(), result->size(), &copied);
  result->resize(length);
  return status == napi_ok;
}

#if defined(_WIN32)
std::wstring Utf8ToWide(const std::string& value) {
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(),
                                  -1, nullptr, 0);
  if (length == 0) return {};
  std::wstring result(static_cast<size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.c_str(), -1,
                          result.data(), length) == 0) {
    return {};
  }
  result.resize(static_cast<size_t>(length - 1));
  return result;
}
#endif

napi_value RenameNoReplace(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != 2) {
    napi_throw_type_error(env, nullptr,
                          "renameNoReplace requires source and destination paths.");
    return nullptr;
  }

  std::string source;
  std::string destination;
  if (!ReadString(env, argv[0], &source) ||
      !ReadString(env, argv[1], &destination)) {
    napi_throw_type_error(env, nullptr, "Paths must be valid strings.");
    return nullptr;
  }

#if defined(_WIN32)
  const std::wstring wide_source = Utf8ToWide(source);
  const std::wstring wide_destination = Utf8ToWide(destination);
  if (wide_source.empty() || wide_destination.empty()) {
    ThrowSystemError(env, "EINVAL", "A path is not valid UTF-8.");
    return nullptr;
  }
  if (!MoveFileW(wide_source.c_str(), wide_destination.c_str())) {
    const DWORD error = GetLastError();
    const char* code = (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS)
                           ? "EEXIST"
                           : (error == ERROR_NOT_SAME_DEVICE ? "EXDEV" : "EIO");
    ThrowSystemError(env, code, "Could not publish the directory without replacement.");
    return nullptr;
  }
#elif defined(__linux__)
  if (syscall(SYS_renameat2, AT_FDCWD, source.c_str(), AT_FDCWD,
              destination.c_str(), 1 /* RENAME_NOREPLACE */) != 0) {
    const int error = errno;
    const char* code = error == EEXIST ? "EEXIST"
                       : error == EXDEV ? "EXDEV"
                       : error == ENOSYS || error == EINVAL || error == EOPNOTSUPP
                             ? "ENOTSUP"
                             : "EIO";
    ThrowSystemError(env, code, "Could not publish the directory without replacement.");
    return nullptr;
  }
#elif defined(__APPLE__)
  if (renamex_np(source.c_str(), destination.c_str(), RENAME_EXCL) != 0) {
    const int error = errno;
    const char* code = error == EEXIST ? "EEXIST"
                       : error == EXDEV ? "EXDEV"
                       : error == ENOTSUP ? "ENOTSUP"
                                          : "EIO";
    ThrowSystemError(env, code, "Could not publish the directory without replacement.");
    return nullptr;
  }
#else
  ThrowSystemError(env, "ENOTSUP",
                   "Atomic no-replace directory publication is not supported on this platform.");
  return nullptr;
#endif

  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {{
      "renameNoReplace", nullptr, RenameNoReplace, nullptr, nullptr, nullptr,
      napi_default, nullptr}};
  napi_define_properties(env, exports, 1, properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
