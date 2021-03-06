/*******************************************************************************
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 * 
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 * 
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 * *****************************************************************************
 * Original Author: Gopi Sankar Karmegam
 ******************************************************************************/
/* jshint moz:true */

const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const VolumeMenu = imports.ui.status.volume;
const { Atk, St, GObject, GLib } = imports.gi;

const Gvc = imports.gi.Gvc;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Lib = Me.imports.convenience;
const _d = Lib._log;
const Prefs = Me.imports.prefs;
const SignalManager = Lib.SignalManager;

function _isDeviceInValid(uidevice){
    return (!uidevice || (uidevice.description && uidevice.description.match(/Dummy\s+(Output|Input)/gi)));
}

var SoundDeviceChooserBase = class SoundDeviceChooserBase {

    constructor(deviceType) {
        _d("SDC: init");
        this.menuItem = new PopupMenu.PopupSubMenuMenuItem('Extension initialising...', true);
        this.deviceType = deviceType;
        this._devices = {};
        this._availableDevicesIds = {};
        let _control = this._getMixerControl();
        this._settings = Lib.getSettings(Prefs.SETTINGS_SCHEMA);
        _d("Constructor" + deviceType);

        this._setLog();
        this._signalManager = new SignalManager();
        this._signalManager.addSignal(this._settings, "changed::" + Prefs.ENABLE_LOG, this._setLog.bind(this));

        if (_control.get_state() == Gvc.MixerControlState.READY) {
            this._onControlStateChanged(_control);
        }
        else {
            this._controlStateChangeSignal = this._signalManager.addSignal(_control, "state-changed", this._onControlStateChanged.bind(this));
        }
    }
    
    _getMixerControl(){return VolumeMenu.getMixerControl();}

    _setLog() { Lib.setLog(this._settings.get_boolean(Prefs.ENABLE_LOG)); }

    _onControlStateChanged(control) {
        if (control.get_state() == Gvc.MixerControlState.READY) {
            if (!this._initialised) {
                this._initialised = true;

                this._signalManager.addSignal(control, this.deviceType + "-added", this._deviceAdded.bind(this));
                this._signalManager.addSignal(control, this.deviceType + "-removed", this._deviceRemoved.bind(this));
                this._signalManager.addSignal(control, "active-" + this.deviceType + "-update", this._deviceActivated.bind(this));
                
                this._signalManager.addSignal(this._settings, "changed::" + Prefs.HIDE_ON_SINGLE_DEVICE, this._setChooserVisibility.bind(this));
                this._signalManager.addSignal(this._settings, "changed::" + Prefs.SHOW_PROFILES, this._setProfileVisibility.bind(this));
                this._signalManager.addSignal(this._settings, "changed::" + Prefs.ICON_THEME, this._setIcons.bind(this));
                this._signalManager.addSignal(this._settings, "changed::" + Prefs.HIDE_MENU_ICONS, this._setIcons.bind(this));
                this._signalManager.addSignal(this._settings, "changed::" + Prefs.PORT_SETTINGS, this._resetDevices.bind(this));

                this._show_device_signal = Prefs["SHOW_" + this.deviceType.toUpperCase() + "_DEVICES"];

                this._signalManager.addSignal(this._settings, "changed::" + this._show_device_signal, this._setVisibility.bind(this));

                this._portsSettings = Prefs.getPortsFromSettings(this._settings);

                /**
                 * There is no direct way to get all the UI devices from
                 * mixercontrol. When enabled after shell loads, the signals
                 * will not be emitted, a simple hack to look for ids, until any
                 * uidevice is not found. The UI devices are always serialed
                 * from from 1 to n
                 */

                let id = 0;
                
                let dummyDevice = new Gvc.MixerUIDevice();
                let maxId = dummyDevice.get_id();
                
                _d("Max Id:" + maxId);
                
                let defaultDevice = this.getDefaultDevice(control);
                while (++id < maxId) {
                    let uidevice = this._deviceAdded(control, id);
                    if (uidevice) {
                        let stream = control.get_stream_from_device(uidevice);
                        if (stream) {
                            let stream_port = stream.get_port();
                            let uidevice_port = uidevice.get_port();

                            if (((!stream_port && !uidevice_port) ||
                                (stream_port && stream_port.port === uidevice_port)) &&
                                stream == defaultDevice) {
                                this._deviceActivated(control, id);
                            }
                        }
                    }
                }
                //We dont have any way to understand that the profile has changed in the settings
                //Just an useless workaround and potentially crashes shell
                this.activeProfileTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000,
                    this._setActiveProfile.bind(this));

                if (this._controlStateChangeSignal) {
                    this._controlStateChangeSignal.disconnect();
                    delete this._controlStateChangeSignal;
                }
                this._setVisibility();
            }
        }
    }


    _deviceAdded(control, id, dontcheck) {
        let obj = this._devices[id];
        let uidevice = this.lookupDeviceById(control,id);
        
        _d("Added - "+ id);

        if (!obj) {
            if (_isDeviceInValid(uidevice)) {
                return null;
            }

            obj = new Object();
            obj.id = id;
            
            obj.text = uidevice.description;
            if (uidevice.origin != "")
                obj.text += " - " + uidevice.origin;

            let icon = uidevice.get_icon_name();
            if (icon == null || icon.trim() == "")
                icon = this.getDefaultIcon();
            obj.icon_name = icon;
            let icon_name = this._getIcon(icon);
            
            obj.item = this.menuItem.menu.addAction(obj.text, function() {
                _d("Device Change request");
                this._changeDeviceBase(this._getMixerControl(), id);
            }.bind(this), icon_name);

            if (!obj.profiles) {
                obj.profiles = Lib.getProfiles(control, uidevice);
            }

            if (!obj.profilesitems) {
                obj.profilesitems = [];
            }
            this._devices[id] = obj;
        }
        
        _d("Device Name:" + obj.text);

        if (obj.profiles) {
            for (let profile of obj.profiles) {
                _d("Profile:" + profile.name);
            }
        }

        if (obj.active) {
            return uidevice;
        }

        _d("Added: " + id + ":" + uidevice.description + ":" + uidevice.port_name + ":" + uidevice.origin);
        if (!this._availableDevicesIds[id]) {
            this._availableDevicesIds[id] = 0;
        }
        this._availableDevicesIds[id]++;

        obj.active = true;
        let stream = control.get_stream_from_device(uidevice);
        if (stream) {
            obj.activeProfile = uidevice.get_active_profile();
        }
        else {
            obj.activeProfile = "";
        }
        
        if (obj.profiles) {
            for (let profile of obj.profiles) {
                let profileItem = obj.profilesitems[profile.name];
                if (!profileItem) {
                    let profileName = profile.name;
                    profileItem = this.menuItem.menu.addAction("Profile: " + profile.human_name, function() {
                        _d("i am setting profile, " + profile.human_name + ":" + uidevice.description + ":" + uidevice.port_name);
                        let stream = control.get_stream_from_device(uidevice);
                        //No Active stream probably inactive port
                        if (!stream) {
                            return;
                        }
                        if (this._activeDevice && this._activeDevice.id !== id) {
                            _d("Changing active device to " + uidevice.description + ":" + uidevice.port_name);
                            this._changeDeviceBase(control, uidevice);
                        }
                        control.change_profile_on_selected_device(uidevice, profileName);
                        this._setDeviceActiveProfile(control, obj);
                    }.bind(this));

                    obj.profilesitems[profileName] = profileItem;
                    profileItem.setProfileActive = function(active) {
                        if (active) {
                            // this._ornamentLabel.text = "\u2727";
                            this._ornamentLabel.text = "\u266A";
                            if (this.add_style_pseudo_class) {
                                this.add_style_pseudo_class('checked');
                                this.remove_style_pseudo_class('insensitive');
                            }
                            else {
                                this.actor.add_style_pseudo_class('checked');
                                this.actor.remove_style_pseudo_class('insensitive');
                            }
                        }
                        else {
                            this._ornamentLabel.text = "";
                            if (this.add_style_pseudo_class) {
                                this.remove_style_pseudo_class('checked');
                                this.add_style_pseudo_class('insensitive');
                            }
                            else {
                                this.actor.remove_style_pseudo_class('checked');
                                this.actor.add_style_pseudo_class('insensitive');
                            }
                        }
                    };
                    profileItem._ornamentLabel.set_style("min-width: 3em;margin-left: 3em;");
                }
                profileItem.setProfileActive(obj.activeProfile == profile.name);
            }
        }
        if (!dontcheck && !this._canShowDevice(control, uidevice, uidevice.port_available)) {
            this._deviceRemoved(control, id, true);
        }
        this._setChooserVisibility();
        this._setVisibility();
        return uidevice;
    }

    _deviceRemoved(control, id, dontcheck) {
        let obj = this._devices[id];
        //let uidevice = this.lookupDeviceById(control,id);
        if (obj && obj.active) {
            _d("Removed: " + id + ":" + obj.text);
            /*
            if (!dontcheck && this._canShowDevice(control, uidevice, false)) {
                _d('Device removed, but not hiding as its set to be shown always');
                return;
            }*/
            delete this._availableDevicesIds[id];
            obj.item.actor.visible = false;
            obj.active = false;
            if (obj.profiles) {
                for (let profile of obj.profiles) {
                    let profileItem = obj.profilesitems[profile.name];
                    if (profileItem) {
                        profileItem.actor.visible = false;
                    }
                }
            }

            if (this.deviceRemovedTimout) {
                GLib.source_remove(this.deviceRemovedTimout);
                this.deviceRemovedTimout = null;
            }
            /**
             * If the active uidevice is removed, then need to activate the
             * first available uidevice. However for some cases like Headphones,
             * when the uidevice is removed, Speakers are automatically
             * activated. So, lets wait for sometime before activating.
             */
            this.deviceRemovedTimout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, function() {
                _d("Device Removed timeout");
                if (obj === this._activeDevice) {
                    let device = Object.keys(this._devices).map((id) => this._devices[id]).find(({active}) => active === true);
                    if(device){
                        this._changeDeviceBase(this._getMixerControl(), device.id);
                    }                    
                }
                this.deviceRemovedTimout = null;
                return false;
            }.bind(this));
            this._setChooserVisibility();
            this._setVisibility();
        }
    }

    _deviceActivated(control, id) {
        _d("Activated:- " + id);
        let obj = this._devices[id];
        if(!obj){
            _d("Activated device not found in the list of devices, try to add");
            this._deviceAdded(control, id);
            obj = this._devices[id];
        }
        if (obj && obj !== this._activeDevice) {
            _d("Activated: " + id + ":" + obj.text);
            if (this._activeDevice) {
                this._activeDevice.item.setOrnament(PopupMenu.Ornament.NONE);
                if (this._activeDevice.item.remove_style_pseudo_class) {
                    this._activeDevice.item.remove_style_pseudo_class('checked');
                }
                else {
                    this._activeDevice.item.actor.remove_style_pseudo_class('checked');
                }
            }
            this._activeDevice = obj;
            obj.item.setOrnament(PopupMenu.Ornament.CHECK);
            if (obj.item.add_style_pseudo_class) {
                obj.item.add_style_pseudo_class('checked');
            }
            else {
                obj.item.actor.add_style_pseudo_class('checked');
            }

            obj.item._ornamentLabel.text = '\u266B';
            this.menuItem.label.text = obj.text;

            if (!this._settings.get_boolean(Prefs.HIDE_MENU_ICONS)) {
                this.menuItem.icon.icon_name = this._getIcon(obj.icon_name);
            } else {
                this.menuItem.icon.gicon = null;
            }
        }
    }
    
    _changeDeviceBase(control, id) {
        let uidevice = this.lookupDeviceById(control, id);
        if(uidevice){
            this.changeDevice(control, uidevice);
        }
        else{
            this._deviceRemoved(control, id);
        }
    }

    _setActiveProfile() {
         let control = this._getMixerControl();
        //_d("Setting Active Profile");
        /*for (let id in this._devices) {
            let device = this._devices[id];
            if (device.active) {
                this._setDeviceActiveProfile(device);
            }
        }*/
        if(this._activeDevice){
            this._setDeviceActiveProfile(control, this._activeDevice);
        }
        return true;
    }

    _setDeviceActiveProfile(device) {
        if (!device || !this._availableDevicesIds[device.id]) {
            return;
        }
       
        let uidevice = this.lookupDeviceById(control,device.id);
        if(!uidevice){
            return;
        }
        let stream = control.get_stream_from_device(uidevice);
        if (!stream) {
            return;
        }
        let activeProfile = uidevice.get_active_profile();
        if (activeProfile && device.activeProfile != activeProfile) {
            device.activeProfile = activeProfile;
            for (let profile of device.profiles) {
                device.profilesitems[profile.name].setProfileActive(profile.name == device.activeProfile);
            }
        }
    }

    _getDeviceVisibility() {
        let hideChooser = this._settings.get_boolean(Prefs.HIDE_ON_SINGLE_DEVICE);
        if (hideChooser) {
            return (Object.keys(this._availableDevicesIds).length > 1);
        }
        else {
            return true;
        }
    }

    _setChooserVisibility() {
        let visibility = this._getDeviceVisibility();
        for (let id in this._availableDevicesIds) {
            this._devices[id].item.actor.visible = visibility;
        }
        this.menuItem._triangleBin.visible = visibility;
        this._setProfileVisibility();
    }

    _setProfileVisibility() {
        let visibility = this._settings.get_boolean(Prefs.SHOW_PROFILES);
        for (let id in this._availableDevicesIds) {
            let device = this._devices[id];
            if (device.profiles) {
                for (let profile of device.profiles) {
                    device.profilesitems[profile.name].actor.visible =
                        (visibility && device.item.actor.visible && Object.keys(device.profilesitems).length > 1);
                }
            }
        }
    }

    _getIcon(name) {
        let iconsType = this._settings.get_string(Prefs.ICON_THEME);
        switch (iconsType) {
            case Prefs.ICON_THEME_COLORED:
                return name;
            case Prefs.ICON_THEME_MONOCHROME:
                return name + "-symbolic";
            default:
                return "none";
        }
    }

    _setIcons() {
        // Set the icons in the selection list
        let control = this._getMixerControl();
        for (let id in this._devices) {
            let uidevice = this.lookupDeviceById(control,id);
            if(uidevice){
                let device = this._devices[id];
                let icon = uidevice.get_icon_name();
                if (icon == null || icon.trim() == "")
                    icon = this.getDefaultIcon();
                device.item.setIcon(this._getIcon(icon));
            }
        }

        // These indicate the active device, which is displayed directly in the
        // Gnome menu, not in the list.
        if (!this._settings.get_boolean(Prefs.HIDE_MENU_ICONS)) {
            this.menuItem.icon.icon_name = this._getIcon(obj.icon_name);
        } else {
            this.menuItem.icon.gicon = null;
        }
    }


    _canShowDevice(control, uidevice, defaultValue) {
        if (!uidevice || !this._portsSettings || uidevice.port_name == null || uidevice.description == null) {
            return defaultValue;
        }
        let stream = control.get_stream_from_device(uidevice);
        let cardName = null;
        if (stream) {
            let cardId = stream.get_card_index();
            if (cardId != null) {
                _d("Card Index" + cardId);
                let _card = Lib.getCard(cardId);
                if (_card) {
                    cardName = _card.name;
                }
                else {
                    //card id found, but not available in list
                    return false;
                }
                _d("Card Name" + cardName);
            }
        }

        for (let port of this._portsSettings) {
            //_d("P" + port.name + "==" + uidevice.port_name + "==" + port.human_name + "==" + uidevice.description + "==" + cardName + "==" + port.card_name)
            if (port && port.name == uidevice.port_name && port.human_name == uidevice.description && (!cardName || cardName == port.card_name)) {
                switch (port.display_option) {
                    case 1:
                        return true;

                    case 2:
                        return false;

                    default:
                        return defaultValue;
                }
            }
        }
        return defaultValue;
    }

    _resetDevices() {
        //this._portsSettings = JSON.parse(this._settings.get_string(Prefs.PORT_SETTINGS));
        this._portsSettings = Prefs.getPortsFromSettings(this._settings);
        let control = this._getMixerControl();
        for (let id in this._devices) {
            let uidevice = this.lookupDeviceById(control,id);
            if (_isDeviceInValid(uidevice)) {
                _d("Device is invalid");
                continue;
            }
            switch (this._canShowDevice(control,uidevice, uidevice.port_available)) {
                case true:
                    this._deviceAdded(control, uidevice.get_id(), true);
                    break;
                case false:
                    this._deviceRemoved(control, uidevice.get_id(), true);
                    break;
            }
        }
    }

    _setVisibility() {
        if (!this._settings.get_boolean(this._show_device_signal))
            this.menuItem.actor.visible = false;
        else
            // if setting says to show device, check for any device, otherwise
            // hide the "actor"
            this.menuItem.actor.visible = (Object.keys(this._availableDevicesIds).length > 0);
    }

    destroy() {
        this._signalManager.disconnectAll();
        if (this.deviceRemovedTimout) {
            GLib.source_remove(this.deviceRemovedTimout);
            this.deviceRemovedTimout = null;
        }
        if (this.activeProfileTimeout) {
            GLib.source_remove(this.activeProfileTimeout);
            this.activeProfileTimeout = null;
        }
        this.menuItem.destroy();
    }
};
