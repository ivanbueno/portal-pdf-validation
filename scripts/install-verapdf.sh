#!/bin/sh
set -eu
url=https://software.verapdf.org/releases/1.30/verapdf-greenfield-1.30.2-installer.zip
curl --fail --silent --show-error --location "$url" -o /tmp/verapdf.zip
printf '%s  %s\n' 6cc6341cb1af644044054b81f00a6590a7918abb18f762243de115258bcad838 /tmp/verapdf.zip | sha256sum -c -
unzip -q /tmp/verapdf.zip -d /tmp/installer
cat > /tmp/install.xml <<'XML'
<AutomatedInstallation langpack="eng">
<com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
<com.izforge.izpack.panels.target.TargetPanel id="install_dir"><installpath>/opt/verapdf</installpath></com.izforge.izpack.panels.target.TargetPanel>
<com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select"><pack index="0" name="veraPDF GUI" selected="true"/><pack index="1" name="veraPDF Mac and *nix Scripts" selected="true"/><pack index="2" name="veraPDF Validation model" selected="true"/></com.izforge.izpack.panels.packs.PacksPanel>
<com.izforge.izpack.panels.install.InstallPanel id="install"/>
<com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>
XML
java -jar /tmp/installer/verapdf-greenfield-1.30.2/verapdf-izpack-installer-1.30.2.jar /tmp/install.xml
find /opt/verapdf -name 'cli-1.30.2.jar' -exec ln -s '{}' /opt/verapdf/cli.jar \;
test -f /opt/verapdf/cli.jar
java -jar /opt/verapdf/cli.jar --version
rm -rf /tmp/installer /tmp/verapdf.zip /tmp/install.xml
