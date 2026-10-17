Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('c:\Users\Yashwanth Prakash K\Desktop\Energy Monitor\SSB_Dashboard_Scope_Document.docx')
$entry = $zip.GetEntry('word/document.xml')
$stream = $entry.Open()
$reader = New-Object System.IO.StreamReader($stream)
$xml = $reader.ReadToEnd()
$reader.Close()
$stream.Close()
$zip.Dispose()
$xmlDoc = New-Object System.Xml.XmlDocument
$xmlDoc.LoadXml($xml)
$nodes = $xmlDoc.GetElementsByTagName('w:t')
foreach ($node in $nodes) {
    Write-Output $node.InnerText
}
