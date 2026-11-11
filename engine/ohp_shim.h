/* Force-included before every ITU source file (clang -include ohp_shim.h).
 *
 * The ITU code calls P.372 routines through dll* function pointers that are
 * filled in by LoadLibrary()/dlopen() on Windows/Linux. We link everything
 * statically into one WebAssembly module, so the pointer names are simply
 * aliased to the real functions. No __linux__/_WIN32 is defined for the
 * wasm32-wasi target, so the dlopen blocks are skipped by the preprocessor.
 */
#ifndef OHP_SHIM_H
#define OHP_SHIM_H

#define DLLEXPORT

#define dllP372Version         P372Version
#define dllP372CompileTime     (char *)P372CompileTime
#define dllNoise               Noise
#define dllAllocateNoiseMemory AllocateNoiseMemory
#define dllFreeNoiseMemory     FreeNoiseMemory
#define dllInitializeNoise     InitializeNoise
#define dllReadFamDud          ReadFamDud

#endif
