# Running the dashboard on a screen attached to the Pi

The hub is a web app, so the usual setup is to leave the Pi headless and open
`http://<pi-ip>:8080` from a phone or a wall tablet. If you have a display
attached to the Pi itself, here is how to boot straight into the dashboard.

On iOS and Android, "Add to Home Screen" gives you a full-screen icon with no
browser chrome — the page already declares the right meta tags for that.

## Chromium kiosk on Raspberry Pi OS (desktop)

```bash
sudo apt install -y chromium-browser unclutter
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/hub-kiosk.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Home Hub
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars --incognito --check-for-update-interval=31536000 http://localhost:8080
X-GNOME-Autostart-enabled=true
EOF
```

`unclutter -idle 0.5 -root &` hides the mouse pointer on a touchscreen.

Disable screen blanking for a wall display:

```bash
sudo raspi-config nonint do_blanking 1
```

## Turning the backlight off at night

An always-on panel in a bedroom hallway gets old. The official 7" touchscreen
exposes its backlight at `/sys/class/backlight/`:

```bash
# off
echo 1 | sudo tee /sys/class/backlight/*/bl_power
# on
echo 0 | sudo tee /sys/class/backlight/*/bl_power
```

Wire that to the hub by adding a cron entry, or use a hub automation that
calls a script. Add a udev rule so your user can write it without sudo:

```
# /etc/udev/rules.d/90-backlight.rules
SUBSYSTEM=="backlight", RUN+="/bin/chmod 666 /sys/class/backlight/%k/bl_power"
```

## A note on performance

A Pi 4 serves this comfortably: the whole dashboard is about 60 kB gzipped and
state arrives over a WebSocket rather than by polling. The hub itself idles at
a few megabytes of RSS; the dominant cost is however often you poll Ring,
which is why `pollSeconds` defaults to 45 for it.
