import Map from "ol/Map.js";
import View from "ol/View.js";
import { unByKey } from "ol/Observable.js";
import Control from "ol/control/Control.js";
import Attribution from "ol/control/Attribution.js";
import Zoom from "ol/control/Zoom.js";
import GeoJSON from "ol/format/GeoJSON.js";
import { defaults as defaultInteractions } from "ol/interaction/defaults.js";
import GroupLayer from "ol/layer/Group.js";
import TileLayer from "ol/layer/Tile.js";
import VectorLayer from "ol/layer/Vector.js";
import { fromLonLat, get, transform } from "ol/proj.js";
import { register as registerProj4 } from "ol/proj/proj4.js";
import TileWMS from "ol/source/TileWMS.js";
import VectorSource from "ol/source/Vector.js";
import Fill from "ol/style/Fill.js";
import Stroke from "ol/style/Stroke.js";
import Style from "ol/style/Style.js";
import TileGrid from "ol/tilegrid/TileGrid.js";

export const ol = {
  Map,
  Observable: {
    unByKey,
  },
  View,
  control: {
    Attribution,
    Control,
    Zoom,
  },
  format: {
    GeoJSON,
  },
  interaction: {
    defaults: {
      defaults: defaultInteractions,
    },
  },
  layer: {
    Group: GroupLayer,
    Tile: TileLayer,
    Vector: VectorLayer,
  },
  proj: {
    fromLonLat,
    get,
    proj4: {
      register: registerProj4,
    },
    transform,
  },
  source: {
    TileWMS,
    Vector: VectorSource,
  },
  style: {
    Fill,
    Stroke,
    Style,
  },
  tilegrid: {
    TileGrid,
  },
};
