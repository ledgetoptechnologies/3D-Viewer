using System.Diagnostics;
using System.Security.Cryptography;
using Obj2Tiles.Library;

// Package-free SDK-build regression, not a runtime service or storage bypass.
var root = Path.Combine(Path.GetTempPath(), "obj2tiles-copy-test-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var source = Path.Combine(root, "sealed.obj");
var bytes = Enumerable.Range(0, 1024 * 1024).Select(i => (byte)(i % 251)).ToArray();
File.WriteAllBytes(source, bytes);
if (OperatingSystem.IsWindows()) File.SetAttributes(source, FileAttributes.ReadOnly);
else File.SetUnixFileMode(source, UnixFileMode.UserRead | UnixFileMode.GroupRead);
var initialHash = SHA256.HashData(File.ReadAllBytes(source));
var initialMode = OperatingSystem.IsWindows() ? (int)File.GetAttributes(source) : (int)File.GetUnixFileMode(source);
var checks = 0;
void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
    checks++;
}
void Refuses(Action action, string message)
{
    try { action(); }
    catch (IOException) { checks++; return; }
    throw new Exception(message);
}
try
{
    var output = Path.Combine(root, "copied.obj");
    IntermediateFileCopy.Copy(source, output);
    Check(File.ReadAllBytes(output).SequenceEqual(bytes), "sealed source bytes were not copied");
    if (!OperatingSystem.IsWindows())
        Check((File.GetUnixFileMode(output) & UnixFileMode.UserWrite) != 0, "intermediate inherited sealed mode");
    using (var writer = new FileStream(output, FileMode.Open, FileAccess.Write)) writer.WriteByte(bytes[0]);
    Check(File.ReadAllBytes(output).SequenceEqual(bytes), "intermediate is not independently writable");
    File.WriteAllText(output, "replace me");
    IntermediateFileCopy.Copy(source, output, overwrite: true);
    Check(File.ReadAllBytes(output).SequenceEqual(bytes), "overwrite did not replace output bytes");
    Refuses(() => IntermediateFileCopy.Copy(source, output, overwrite: false), "overwrite=false replaced existing output");
    Check(File.ReadAllBytes(output).SequenceEqual(bytes), "refused overwrite mutated output");
    Refuses(() => IntermediateFileCopy.Copy(source, source), "source alias was accepted");
    Refuses(() => IntermediateFileCopy.Copy(source, Path.Combine(root, ".", "sealed.obj")), "normalized source alias was accepted");
    var existingDirectory = Path.Combine(root, "cannot-replace-directory");
    Directory.CreateDirectory(existingDirectory);
    Refuses(() => IntermediateFileCopy.Copy(source, existingDirectory), "copy replaced an existing directory");
    Check(Directory.Exists(existingDirectory), "failed promotion changed destination directory");
    Check(Directory.GetFiles(root, ".obj2tiles-copy-*").Length == 0, "failed promotion leaked owned temporary");
    if (!OperatingSystem.IsWindows())
    {
        var link = Path.Combine(root, "destination-link.obj");
        File.CreateSymbolicLink(link, source);
        Refuses(() => IntermediateFileCopy.Copy(source, link), "destination symlink was accepted");
        Refuses(() => IntermediateFileCopy.Copy(link, Path.Combine(root, "from-link.obj")), "source symlink was accepted");
        var broken = Path.Combine(root, "broken-link.obj");
        File.CreateSymbolicLink(broken, Path.Combine(root, "missing.obj"));
        Refuses(() => IntermediateFileCopy.Copy(source, broken), "dangling output symlink was accepted");
        var linkedParent = Path.Combine(root, "linked-parent");
        Directory.CreateSymbolicLink(linkedParent, root);
        Refuses(() => IntermediateFileCopy.Copy(source, Path.Combine(linkedParent, "escape.obj")), "linked output ancestor was accepted");
        Refuses(() => IntermediateFileCopy.Copy(Path.Combine(linkedParent, "sealed.obj"), Path.Combine(root, "from-linked-parent.obj")), "linked source ancestor was accepted");
        Directory.Delete(linkedParent);
        var hardLink = Path.Combine(root, "hard-link.obj");
        var start = new ProcessStartInfo("/bin/ln") { UseShellExecute = false };
        start.ArgumentList.Add(source);
        start.ArgumentList.Add(hardLink);
        using (var process = Process.Start(start)!)
        {
            process.WaitForExit();
            Check(process.ExitCode == 0, "hard-link fixture creation failed");
        }
        Refuses(() => IntermediateFileCopy.Copy(source, hardLink, overwrite: false), "overwrite=false replaced a hard-linked output");
        Check(File.ReadAllBytes(source).SequenceEqual(bytes), "refused hard-link overwrite mutated source");
        IntermediateFileCopy.Copy(source, hardLink, overwrite: true);
        using (var writer = new FileStream(hardLink, FileMode.Open, FileAccess.Write)) writer.WriteByte(0xff);
        Check(File.ReadAllBytes(source).SequenceEqual(bytes), "hard-linked output overwrite mutated source inode");
    }
    Check(SHA256.HashData(File.ReadAllBytes(source)).SequenceEqual(initialHash), "retained source hash changed");
    Check((OperatingSystem.IsWindows() ? (int)File.GetAttributes(source) : (int)File.GetUnixFileMode(source)) == initialMode,
        "retained source permissions changed");
    Check(Directory.GetFiles(root, ".obj2tiles-copy-*").Length == 0, "owned copy temporary leaked");
    Console.WriteLine($"IntermediateFileCopy regression passed: {checks} checks");
}
finally
{
    // This directory contains only harness-owned fixtures, never retained data.
    if (OperatingSystem.IsWindows()) File.SetAttributes(source, FileAttributes.Normal);
    Directory.Delete(root, recursive: true);
}
