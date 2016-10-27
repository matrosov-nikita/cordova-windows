/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
*/

var util = require('util');
var semver = require('semver');
var CommonMunger = require('cordova-common').ConfigChanges.PlatformMunger;
var MANIFESTS = {
    'windows': {
        '8.1.0': 'package.windows.appxmanifest',
        '10.0.0': 'package.windows10.appxmanifest'
    },
    'phone': {
        '8.1.0': 'package.phone.appxmanifest',
        '10.0.0': 'package.windows10.appxmanifest'
    },
    'all': {
        '8.1.0': ['package.windows.appxmanifest', 'package.phone.appxmanifest'],
        '10.0.0': 'package.windows10.appxmanifest'
    }
};
function PlatformMunger(platform, project_dir, platformJson, pluginInfoProvider) {
    CommonMunger.apply(this, arguments);
}

util.inherits(PlatformMunger, CommonMunger);

/**
 * This is an override of apply_file_munge method from cordova-common's PlatformMunger class.
 * In addition to parent's method logic also removes capabilities with 'uap:' prefix that were
 * added by AppxManifest class
 *
 * @param {String}  file   A file name to apply munge to
 * @param {Object}  munge  Serialized changes that need to be applied to the file
 * @param {Boolean} [remove=false] Flag that specifies whether the changes
 *   need to be removed or added to the file
 */
PlatformMunger.prototype.apply_file_munge = function (file, munge, remove) {
    // Call parent class' method
    PlatformMunger.super_.prototype.apply_file_munge.call(this, file, munge, remove);

    // CB-11066 If this is a windows10 manifest and we're removing the changes
    // then we also need to check if there are <Capability> elements were previously
    // added and schedule removal of corresponding <uap:Capability> elements
    if (remove && file === 'package.windows10.appxmanifest') {
        var uapCapabilitiesMunge = generateUapCapabilities(munge);
        // We do not check whether generated munge is empty or not before calling
        // 'apply_file_munge' since applying empty one is just a no-op
        PlatformMunger.super_.prototype.apply_file_munge.call(this, file, uapCapabilitiesMunge, remove);
    }
};

/**
 * Generates a new munge that contains <uap:Capability> elements created based on
 * corresponding <Capability> elements from base munge. If there are no such elements
 * found in base munge, the empty munge is returned (selectors might be present under
 * the 'parents' key, but they will contain no changes).
 *
 * @param {Object} munge A munge that we need to check for <Capability> elements
 * @return {Object} A munge with 'uap'-prefixed capabilities or empty one
 */
function generateUapCapabilities(munge) {

    function hasCapabilityChange(change) {
        return /^\s*<Capability\s/.test(change.xml);
    }

    function createPrefixedCapabilityChange(change) {
        return {
            xml: change.xml.replace(/Capability/, 'uap:Capability'),
            count: change.count,
            before: change.before
        };
    }

    // Iterate through all selectors in munge
    return Object.keys(munge.parents)
    .reduce(function (result, selector) {
        result.parents[selector] = munge.parents[selector]
        // For every xml change check if it adds a <Capability> element ...
        .filter(hasCapabilityChange)
        // ... and create a duplicate with 'uap:' prefix
        .map(createPrefixedCapabilityChange);

        return result;
    }, { parents: {} });
}

PlatformMunger.prototype.generate_plugin_config_munge = function (changes, plugin_id, vars, edit_config_changes) {
    var self = this;

    if(edit_config_changes) {
        Array.prototype.push.apply(changes, edit_config_changes);
    }

    // Demux 'package.appxmanifest' into relevant platform-specific appx manifests.
    // Only spend the cycles if there are version-specific plugin settings
    if (changes.some(function(change) {
                return ((typeof change.versions !== 'undefined') ||
                    (typeof change.deviceTarget !== 'undefined'));
            }))
    {
        var oldChanges = changes;
        changes = [];

        oldChanges.forEach(function(change, changeIndex) {
            // Only support semver/device-target demux for package.appxmanifest
            // Pass through in case something downstream wants to use it
            if (change.target !== 'package.appxmanifest') {
                changes.push(change);
                return;
            }

            var hasVersion = (typeof change.versions !== 'undefined');
            var hasTargets = (typeof change.deviceTarget !== 'undefined');

            // No semver/device-target for this config-file, pass it through
            if (!(hasVersion || hasTargets)) {
                changes.push(change);
                return;
            }

            var targetDeviceSet = hasTargets ? change.deviceTarget : 'all';
            if (['windows', 'phone', 'all'].indexOf(targetDeviceSet) === -1) {
                // target-device couldn't be resolved, fix it up here to a valid value
                targetDeviceSet = 'all';
            }
            var knownWindowsVersionsForTargetDeviceSet = Object.keys(MANIFESTS[targetDeviceSet]);

            // at this point, 'change' targets package.appxmanifest and has a version attribute
            knownWindowsVersionsForTargetDeviceSet.forEach(function(winver) {
                // This is a local function that creates the new replacement representing the
                // mutation.  Used to save code further down.
                var createReplacement = function(manifestFile, originalChange) {
                    var replacement = {
                        target:         manifestFile,
                        parent:         originalChange.parent,
                        after:          originalChange.after,
                        xmls:           originalChange.xmls,
                        versions:       originalChange.versions,
                        deviceTarget:   originalChange.deviceTarget
                    };
                    return replacement;
                };

                // version doesn't satisfy, so skip
                if (hasVersion && !semver.satisfies(winver, change.versions)) {
                    return;
                }

                var versionSpecificManifests = MANIFESTS[targetDeviceSet][winver];
                if (versionSpecificManifests.constructor === Array) {
                    // e.g. all['8.1.0'] === ['pkg.windows.appxmanifest', 'pkg.phone.appxmanifest']
                    versionSpecificManifests.forEach(function(manifestFile) {
                        changes.push(createReplacement(manifestFile, change));
                    });
                }
                else {
                    // versionSpecificManifests is actually a single string
                    changes.push(createReplacement(versionSpecificManifests, change));
                }
            });
        });

        return PlatformMunger.super_.prototype.generate_plugin_config_munge.call(self, changes, plugin_id, vars);
    }

    return PlatformMunger.super_.prototype.generate_plugin_config_munge.call(self, changes, plugin_id, vars, edit_config_changes);
};

exports.PlatformMunger = PlatformMunger;
