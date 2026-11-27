using System.Runtime.InteropServices;
using Avalonia.Platform;

namespace MultiCodexStateGui.Services;

internal static class MacDockIcon
{
    // A standalone Mach-O has no bundle icon for AppKit to load automatically.
    public static void Apply()
    {
        using var asset = AssetLoader.Open(new Uri("avares://MultiCodexStateGui/Assets/app-icon.png"));
        using var buffer = new MemoryStream();
        asset.CopyTo(buffer);
        var bytes = buffer.ToArray();
        var data = DataWithBytes(GetClass("NSData"), Selector("dataWithBytes:length:"), bytes, (nuint)bytes.Length);
        var allocated = Send(GetClass("NSImage"), Selector("alloc"));
        var image = SendArgument(allocated, Selector("initWithData:"), data);
        if (image == 0) return;
        try
        {
            var application = Send(GetClass("NSApplication"), Selector("sharedApplication"));
            SetArgument(application, Selector("setApplicationIconImage:"), image);
        }
        finally
        {
            Release(image, Selector("release"));
        }
    }

    private const string ObjC = "/usr/lib/libobjc.A.dylib";

    [DllImport(ObjC, EntryPoint = "objc_getClass")]
    private static extern nint GetClass(string name);

    [DllImport(ObjC, EntryPoint = "sel_registerName")]
    private static extern nint Selector(string name);

    [DllImport(ObjC, EntryPoint = "objc_msgSend")]
    private static extern nint Send(nint receiver, nint selector);

    [DllImport(ObjC, EntryPoint = "objc_msgSend")]
    private static extern nint SendArgument(nint receiver, nint selector, nint value);

    [DllImport(ObjC, EntryPoint = "objc_msgSend")]
    private static extern void SetArgument(nint receiver, nint selector, nint value);

    [DllImport(ObjC, EntryPoint = "objc_msgSend")]
    private static extern void Release(nint receiver, nint selector);

    [DllImport(ObjC, EntryPoint = "objc_msgSend")]
    private static extern nint DataWithBytes(nint receiver, nint selector, byte[] bytes, nuint length);
}
