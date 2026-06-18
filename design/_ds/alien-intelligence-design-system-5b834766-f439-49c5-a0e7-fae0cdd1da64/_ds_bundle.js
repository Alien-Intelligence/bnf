/* @ds-bundle: {"format":3,"namespace":"AlienIntelligenceDesignSystem_5b8347","components":[{"name":"Badge","sourcePath":"components/badges/Badge.jsx"},{"name":"MethodBadge","sourcePath":"components/badges/MethodBadge.jsx"},{"name":"Button","sourcePath":"components/buttons/Button.jsx"},{"name":"Avatar","sourcePath":"components/display/Avatar.jsx"},{"name":"Card","sourcePath":"components/display/Card.jsx"},{"name":"CardHeader","sourcePath":"components/display/Card.jsx"},{"name":"CardTitle","sourcePath":"components/display/Card.jsx"},{"name":"CardDescription","sourcePath":"components/display/Card.jsx"},{"name":"CardContent","sourcePath":"components/display/Card.jsx"},{"name":"CardFooter","sourcePath":"components/display/Card.jsx"},{"name":"StatCard","sourcePath":"components/display/StatCard.jsx"},{"name":"Table","sourcePath":"components/display/Table.jsx"},{"name":"Tabs","sourcePath":"components/display/Tabs.jsx"},{"name":"TabsList","sourcePath":"components/display/Tabs.jsx"},{"name":"TabsTrigger","sourcePath":"components/display/Tabs.jsx"},{"name":"TabsContent","sourcePath":"components/display/Tabs.jsx"},{"name":"EmptyState","sourcePath":"components/feedback/EmptyState.jsx"},{"name":"Tooltip","sourcePath":"components/feedback/Tooltip.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"SegmentedControl","sourcePath":"components/navigation/SegmentedControl.jsx"}],"sourceHashes":{"components/badges/Badge.jsx":"76982487dc52","components/badges/MethodBadge.jsx":"36bc0cdac669","components/buttons/Button.jsx":"e7054fe30df3","components/display/Avatar.jsx":"8d2cc20d1368","components/display/Card.jsx":"1db85b961b6a","components/display/StatCard.jsx":"f05d4c625f76","components/display/Table.jsx":"014c084cecd7","components/display/Tabs.jsx":"acc10eb8fa55","components/feedback/EmptyState.jsx":"5d92b5cc9b89","components/feedback/Tooltip.jsx":"ea6112ced804","components/forms/Input.jsx":"9c56654fe987","components/forms/Switch.jsx":"2f3fb7db7662","components/navigation/SegmentedControl.jsx":"d7252ca9a327","ui_kits/web-app/App.jsx":"62a842a18a40","ui_kits/web-app/Icon.jsx":"270e710f906f","ui_kits/web-app/Sidebar.jsx":"3b4f6f0714a6","ui_kits/web-app/screens.jsx":"81e41a17d226"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.AlienIntelligenceDesignSystem_5b8347 = window.AlienIntelligenceDesignSystem_5b8347 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/badges/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Badge — small status / label pill (fully rounded).
 * Variants mirror the app: default, primary, outline, muted, success,
 * warning, destructive. Optional leading icon via `startIcon`.
 */
function Badge({
  variant = "outline",
  size = "md",
  startIcon,
  className = "",
  children,
  ...props
}) {
  const classes = ["ds-badge", `ds-badge--${variant}`, size === "sm" ? "ds-badge--sm" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", _extends({
    className: classes
  }, props), startIcon, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/badges/Badge.jsx", error: String((e && e.message) || e) }); }

// components/badges/MethodBadge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const KNOWN = ["get", "post", "put", "delete", "patch"];

/**
 * MethodBadge — mono HTTP-verb tag (GET/POST/PUT/DELETE/PATCH), color-coded.
 * Used in API / MCP endpoint listings.
 */
function MethodBadge({
  method = "GET",
  className = "",
  ...props
}) {
  const upper = String(method).toUpperCase();
  const key = upper.toLowerCase();
  const variantClass = KNOWN.includes(key) ? `ds-method--${key}` : "";
  const classes = ["ds-badge", "ds-badge--sm", "ds-method", variantClass, className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", _extends({
    className: classes
  }, props), upper);
}
Object.assign(__ds_scope, { MethodBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/badges/MethodBadge.jsx", error: String((e && e.message) || e) }); }

// components/buttons/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Button — the primary action primitive.
 * Mirrors the app's CVA button: teal `primary` is the default action, with
 * `secondary`, `outline`, `ghost`, `destructive` and `link` variants and
 * `sm` / `default` / `lg` / `icon` sizes. Renders a real <button>.
 */
function Button({
  variant = "primary",
  size = "default",
  className = "",
  type = "button",
  children,
  ...props
}) {
  const classes = ["ds-btn", `ds-btn--${variant}`, size !== "default" ? `ds-btn--${size}` : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("button", _extends({
    className: classes,
    type: type
  }, props), children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/buttons/Button.jsx", error: String((e && e.message) || e) }); }

// components/display/Avatar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Avatar — circular user/org mark. Pass `src` for an image, otherwise the
 * `fallback` initials render on a neutral fill. Sizes: sm / md / lg.
 */
function Avatar({
  src,
  alt = "",
  fallback = "",
  size = "md",
  className = "",
  ...props
}) {
  const classes = ["ds-avatar", size !== "md" ? `ds-avatar--${size}` : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", _extends({
    className: classes
  }, props), src ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: alt
  }) : fallback);
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/display/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Card — surface container. One step lighter than the canvas, 1px border,
 * faint shadow, 8px radius. Compose with the sub-parts below.
 * Pass `interactive` for the hover-lift used by clickable list cards.
 */
function Card({
  interactive = false,
  className = "",
  children,
  ...props
}) {
  const classes = ["ds-card", interactive ? "ds-card--link" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", _extends({
    className: classes
  }, props), children);
}
function CardHeader({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["ds-card__header", className].filter(Boolean).join(" ")
  }, props), children);
}
function CardTitle({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["ds-card__title", className].filter(Boolean).join(" ")
  }, props), children);
}
function CardDescription({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["ds-card__desc", className].filter(Boolean).join(" ")
  }, props), children);
}
function CardContent({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["ds-card__content", className].filter(Boolean).join(" ")
  }, props), children);
}
function CardFooter({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["ds-card__footer", className].filter(Boolean).join(" ")
  }, props), children);
}
Object.assign(__ds_scope, { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Card.jsx", error: String((e && e.message) || e) }); }

// components/display/StatCard.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * StatCard — dashboard metric tile. Label + optional icon, a large mono value,
 * an optional up/down delta and an optional sparkline (pass an array of numbers).
 */
function StatCard({
  label,
  value,
  icon,
  delta,
  deltaDir = "up",
  spark,
  className = "",
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["ds-stat", className].filter(Boolean).join(" ")
  }, props), /*#__PURE__*/React.createElement("div", {
    className: "ds-stat__top"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-stat__label"
  }, label), icon && /*#__PURE__*/React.createElement("span", {
    className: "ds-stat__icon"
  }, icon)), /*#__PURE__*/React.createElement("div", {
    className: "ds-stat__value"
  }, value), delta && /*#__PURE__*/React.createElement("span", {
    className: `ds-stat__delta ds-stat__delta--${deltaDir}`
  }, delta), spark && spark.length > 1 && /*#__PURE__*/React.createElement("svg", {
    className: "ds-stat__spark",
    viewBox: "0 0 100 28",
    width: "100%",
    height: "28",
    preserveAspectRatio: "none"
  }, /*#__PURE__*/React.createElement("polyline", {
    fill: "none",
    stroke: "var(--brand-teal)",
    strokeWidth: "1.5",
    points: spark.map((v, i) => {
      const max = Math.max(...spark);
      const min = Math.min(...spark);
      const x = i / (spark.length - 1) * 100;
      const y = 26 - (v - min) / (max - min || 1) * 24;
      return `${x},${y}`;
    }).join(" ")
  })));
}
Object.assign(__ds_scope, { StatCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/StatCard.jsx", error: String((e && e.message) || e) }); }

// components/display/Table.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Table — bordered data table. Pass `columns` (array of {key, label, align,
 * mono}) and `rows` (array of objects). Cells can hold any node (badges,
 * avatars). For full control, compose the raw .ds-table markup instead.
 */
function Table({
  columns,
  rows,
  className = "",
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["ds-table-wrap", className].filter(Boolean).join(" ")
  }, props), /*#__PURE__*/React.createElement("table", {
    className: "ds-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, columns.map(c => /*#__PURE__*/React.createElement("th", {
    key: c.key,
    className: c.align === "right" || c.mono ? "num" : ""
  }, c.label)))), /*#__PURE__*/React.createElement("tbody", null, rows.map((r, i) => /*#__PURE__*/React.createElement("tr", {
    key: r.id ?? i
  }, columns.map(c => /*#__PURE__*/React.createElement("td", {
    key: c.key,
    className: c.align === "right" || c.mono ? "num" : ""
  }, r[c.key])))))));
}
Object.assign(__ds_scope, { Table });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Table.jsx", error: String((e && e.message) || e) }); }

// components/display/Tabs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const TabsContext = React.createContext(null);

/**
 * Tabs — segmented control + panels. Controlled (`value` + `onValueChange`)
 * or uncontrolled (`defaultValue`). Compose with TabsList / TabsTrigger / TabsContent.
 */
function Tabs({
  value,
  defaultValue,
  onValueChange,
  className = "",
  children,
  ...props
}) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState(defaultValue);
  const active = isControlled ? value : internal;
  const setActive = next => {
    if (!isControlled) setInternal(next);
    onValueChange && onValueChange(next);
  };
  return /*#__PURE__*/React.createElement(TabsContext.Provider, {
    value: {
      active,
      setActive
    }
  }, /*#__PURE__*/React.createElement("div", _extends({
    className: ["ds-tabs", className].filter(Boolean).join(" ")
  }, props), children));
}
function TabsList({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "tablist",
    className: ["ds-tabs__list", className].filter(Boolean).join(" ")
  }, props), children);
}
function TabsTrigger({
  value,
  className = "",
  children,
  ...props
}) {
  const ctx = React.useContext(TabsContext);
  const isActive = ctx?.active === value;
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    role: "tab",
    "aria-selected": isActive,
    "data-state": isActive ? "active" : "inactive",
    onClick: () => ctx?.setActive(value),
    className: ["ds-tabs__trigger", className].filter(Boolean).join(" ")
  }, props), children);
}
function TabsContent({
  value,
  className = "",
  children,
  ...props
}) {
  const ctx = React.useContext(TabsContext);
  if (ctx?.active !== value) return null;
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "tabpanel",
    className: className
  }, props), children);
}
Object.assign(__ds_scope, { Tabs, TabsList, TabsTrigger, TabsContent });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/feedback/EmptyState.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * EmptyState — centered placeholder for empty lists/panels. Icon + title +
 * description, optional action node.
 */
function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["ds-empty", className].filter(Boolean).join(" ")
  }, props), icon && /*#__PURE__*/React.createElement("span", {
    className: "ds-empty__icon"
  }, icon), title && /*#__PURE__*/React.createElement("div", {
    className: "ds-empty__title"
  }, title), description && /*#__PURE__*/React.createElement("div", {
    className: "ds-empty__desc"
  }, description), action && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "var(--space-2)"
    }
  }, action));
}
Object.assign(__ds_scope, { EmptyState });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/EmptyState.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Tooltip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Tooltip — wrap any trigger; the bubble shows on hover/focus. Light bubble on
 * the dark UI (matches the product). `label` is the bubble text/node.
 */
function Tooltip({
  label,
  children,
  className = "",
  ...props
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    className: ["ds-tooltip", className].filter(Boolean).join(" "),
    tabIndex: 0
  }, props), children, /*#__PURE__*/React.createElement("span", {
    className: "ds-tooltip__bubble",
    role: "tooltip"
  }, label));
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Tooltip.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Input — single-line text field. Transparent dark fill, 1px border,
 * teal-adjacent focus ring. Set `aria-invalid` for the error state.
 */
function Input({
  className = "",
  type = "text",
  ...props
}) {
  return /*#__PURE__*/React.createElement("input", _extends({
    className: ["ds-input", className].filter(Boolean).join(" "),
    type: type
  }, props));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Switch — boolean toggle. Controlled via `checked` + `onCheckedChange`, or
 * uncontrolled with `defaultChecked`. Track turns teal when on.
 */
function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled = false,
  className = "",
  ...props
}) {
  const isControlled = checked !== undefined;
  const [internal, setInternal] = React.useState(defaultChecked);
  const on = isControlled ? checked : internal;
  const toggle = () => {
    if (disabled) return;
    if (!isControlled) setInternal(!on);
    onCheckedChange && onCheckedChange(!on);
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    role: "switch",
    "aria-checked": on,
    "data-state": on ? "checked" : "unchecked",
    disabled: disabled,
    onClick: toggle,
    className: ["ds-switch", className].filter(Boolean).join(" ")
  }, props), /*#__PURE__*/React.createElement("span", {
    className: "ds-switch__thumb"
  }));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/navigation/SegmentedControl.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * SegmentedControl — compact mono toggle group (the dashboard's 24h/7d/30d
 * range picker). Controlled (`value` + `onChange`) or uncontrolled
 * (`defaultValue`). `options` is an array of { value, label }.
 */
function SegmentedControl({
  options,
  value,
  defaultValue,
  onChange,
  className = "",
  ...props
}) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState(defaultValue ?? options[0]?.value);
  const active = isControlled ? value : internal;
  const pick = v => {
    if (!isControlled) setInternal(v);
    onChange && onChange(v);
  };
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["ds-segmented", className].filter(Boolean).join(" "),
    role: "group"
  }, props), options.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.value,
    type: "button",
    className: "ds-segmented__item",
    "aria-pressed": active === o.value,
    onClick: () => pick(o.value)
  }, o.label)));
}
Object.assign(__ds_scope, { SegmentedControl });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/SegmentedControl.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web-app/App.jsx
try { (() => {
/*
 * App — the interactive shell that wires the sidebar to the screens.
 * Click a marketplace dataset to open its detail; use the sidebar to move
 * between Marketplace, Consumption and the MCP endpoint view.
 */
function Topbar({
  crumbs
}) {
  return /*#__PURE__*/React.createElement("header", {
    className: "topbar"
  }, /*#__PURE__*/React.createElement("nav", {
    className: "crumbs"
  }, crumbs.map((c, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: i
  }, i > 0 && /*#__PURE__*/React.createElement(Icon, {
    name: "chevron-right",
    size: 14,
    style: {
      color: "var(--muted-foreground)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: i === crumbs.length - 1 ? "crumb is-current" : "crumb"
  }, c)))), /*#__PURE__*/React.createElement("div", {
    className: "topbar-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "ds-btn ds-btn--ghost ds-btn--icon",
    "aria-label": "Search"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 16
  })), /*#__PURE__*/React.createElement("button", {
    className: "ds-btn ds-btn--ghost ds-btn--icon",
    "aria-label": "Notifications"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "bell",
    size: 16
  })), /*#__PURE__*/React.createElement("button", {
    className: "ds-btn ds-btn--primary ds-btn--sm"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plus",
    size: 15
  }), "New dataset")));
}
function App() {
  const [view, setView] = React.useState("overview");
  const [dataset, setDataset] = React.useState(null);
  const openDataset = d => {
    setDataset(d);
    setView("detail");
  };
  const navigate = v => {
    setView(v);
    setDataset(null);
  };
  const crumbsFor = () => {
    if (view === "detail" && dataset) return ["Marketplace", "Science", dataset.name];
    if (view === "marketplace") return ["Marketplace", "Science"];
    if (view === "consumption") return ["Consumption"];
    if (view === "mcp") return ["My Outputs", "MCP"];
    return ["Overview"];
  };
  const activeNav = view === "detail" ? "marketplace" : view;
  return /*#__PURE__*/React.createElement("div", {
    className: "app"
  }, /*#__PURE__*/React.createElement(Sidebar, {
    active: activeNav,
    onNavigate: navigate
  }), /*#__PURE__*/React.createElement("div", {
    className: "main"
  }, /*#__PURE__*/React.createElement(Topbar, {
    crumbs: crumbsFor()
  }), /*#__PURE__*/React.createElement("div", {
    className: "content"
  }, view === "marketplace" && /*#__PURE__*/React.createElement(Marketplace, {
    onOpen: openDataset
  }), view === "detail" && dataset && /*#__PURE__*/React.createElement(DatasetDetail, {
    d: dataset,
    onBack: () => navigate("marketplace")
  }), view === "consumption" && /*#__PURE__*/React.createElement(Consumption, null), view === "mcp" && /*#__PURE__*/React.createElement(MCP, null), (view === "overview" || view === "clusters") && /*#__PURE__*/React.createElement(Dashboard, {
    onNavigate: navigate
  }))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web-app/App.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web-app/Icon.jsx
try { (() => {
/*
 * Icon — thin wrapper over Lucide (the brand's icon system).
 * Renders a single Lucide glyph by name. Requires the lucide UMD script.
 */
function Icon({
  name,
  size = 16,
  strokeWidth = 2,
  className = "",
  style = {}
}) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!ref.current || !window.lucide) return;
    ref.current.innerHTML = `<i data-lucide="${name}"></i>`;
    window.lucide.createIcons({
      attrs: {
        "stroke-width": strokeWidth
      }
    });
    const svg = ref.current.querySelector("svg");
    if (svg) {
      svg.setAttribute("width", size);
      svg.setAttribute("height", size);
      svg.style.display = "block";
    }
  }, [name, size, strokeWidth]);
  return /*#__PURE__*/React.createElement("span", {
    ref: ref,
    className: className,
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      ...style
    }
  });
}
Object.assign(window, {
  Icon
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web-app/Icon.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web-app/Sidebar.jsx
try { (() => {
/*
 * Sidebar — the app's primary navigation. Mirrors the real groups:
 * Overview / Consumption, My Inputs (Clusters, External APIs), My Outputs
 * (Workflows, MCP), Marketplace (Data text, Voices), and the org/user chrome.
 */
function SidebarItem({
  icon,
  label,
  active,
  soon,
  sub,
  onClick
}) {
  return /*#__PURE__*/React.createElement("button", {
    className: "side-item" + (active ? " is-active" : "") + (soon ? " is-soon" : "") + (sub ? " is-sub" : ""),
    onClick: soon ? undefined : onClick,
    disabled: soon
  }, icon && /*#__PURE__*/React.createElement(Icon, {
    name: icon,
    size: 16
  }), /*#__PURE__*/React.createElement("span", null, label), soon && /*#__PURE__*/React.createElement("span", {
    className: "soon-tag"
  }, "soon"));
}
function SidebarGroup({
  label,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "side-group"
  }, label && /*#__PURE__*/React.createElement("div", {
    className: "side-label"
  }, label), children);
}
function Sidebar({
  active,
  onNavigate
}) {
  return /*#__PURE__*/React.createElement("aside", {
    className: "sidebar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "side-header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "org"
  }, /*#__PURE__*/React.createElement("span", {
    className: "org-mark"
  }, "TI"), /*#__PURE__*/React.createElement("div", {
    className: "org-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "org-name"
  }, "Techniques de l'Ing\xE9nieur"), /*#__PURE__*/React.createElement("span", {
    className: "org-plan"
  }, "Publisher \xB7 Pro")), /*#__PURE__*/React.createElement(Icon, {
    name: "chevrons-up-down",
    size: 14,
    style: {
      marginLeft: "auto",
      color: "var(--muted-foreground)"
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "side-scroll"
  }, /*#__PURE__*/React.createElement(SidebarGroup, null, /*#__PURE__*/React.createElement(SidebarItem, {
    icon: "house",
    label: "Overview",
    active: active === "overview",
    onClick: () => onNavigate("overview")
  }), /*#__PURE__*/React.createElement(SidebarItem, {
    icon: "chart-no-axes-column",
    label: "Consumption",
    active: active === "consumption",
    onClick: () => onNavigate("consumption")
  })), /*#__PURE__*/React.createElement(SidebarGroup, {
    label: "My Inputs"
  }, /*#__PURE__*/React.createElement(SidebarItem, {
    icon: "database",
    label: "Clusters",
    active: active === "clusters",
    onClick: () => onNavigate("clusters")
  }), /*#__PURE__*/React.createElement(SidebarItem, {
    icon: "file-input",
    label: "External APIs"
  })), /*#__PURE__*/React.createElement(SidebarGroup, {
    label: "My Outputs"
  }, /*#__PURE__*/React.createElement(SidebarItem, {
    icon: "network",
    label: "Workflows"
  }), /*#__PURE__*/React.createElement(SidebarItem, {
    icon: "plug",
    label: "MCP",
    active: active === "mcp",
    onClick: () => onNavigate("mcp")
  })), /*#__PURE__*/React.createElement(SidebarGroup, {
    label: "Marketplace"
  }, /*#__PURE__*/React.createElement(SidebarItem, {
    icon: "test-tube-diagonal",
    label: "Science",
    active: active === "marketplace",
    onClick: () => onNavigate("marketplace")
  }), /*#__PURE__*/React.createElement(SidebarItem, {
    icon: "stethoscope",
    label: "Health",
    onClick: () => onNavigate("marketplace")
  }), /*#__PURE__*/React.createElement(SidebarItem, {
    icon: "book-open",
    label: "Voices"
  }), /*#__PURE__*/React.createElement(SidebarItem, {
    icon: "image",
    label: "Images",
    soon: true
  }))), /*#__PURE__*/React.createElement("div", {
    className: "side-footer"
  }, /*#__PURE__*/React.createElement("button", {
    className: "side-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-avatar ds-avatar--sm"
  }, "ML"), /*#__PURE__*/React.createElement("div", {
    className: "side-user"
  }, /*#__PURE__*/React.createElement("span", {
    className: "su-name"
  }, "Marie Laurent"), /*#__PURE__*/React.createElement("span", {
    className: "su-mail"
  }, "marie@techniques.fr")), /*#__PURE__*/React.createElement(Icon, {
    name: "ellipsis-vertical",
    size: 14,
    style: {
      marginLeft: "auto",
      color: "var(--muted-foreground)"
    }
  }))));
}
Object.assign(window, {
  Sidebar
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web-app/Sidebar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web-app/screens.jsx
try { (() => {
/*
 * Screens for the Web App kit: Marketplace (dataset grid), DatasetDetail,
 * Consumption (tabs + usage bars), MCP (endpoint list). Compose the design
 * system's .ds-* classes (Card, Badge, Tabs, Button, Switch, MethodBadge).
 */

const DATASETS = [{
  slug: "openaire",
  name: "OpenAIRE",
  source: "OpenAIRE",
  color: 3,
  cat: "science",
  price: "$0.004",
  files: "190M",
  desc: "190M+ scientific papers and their citation graph, made available to AI systems.",
  certified: true
}, {
  slug: "techniques-ingenieur",
  name: "Techniques de l'Ingénieur",
  source: "T.I.",
  color: 4,
  cat: "science",
  price: "$0.012",
  files: "2.1M",
  desc: "70 years of engineering & scientific archives, transformed into liquid AI assets.",
  certified: true
}, {
  slug: "legal-data-space",
  name: "Legal Data Space",
  source: "LDS",
  color: 2,
  cat: "legal",
  price: "$0.020",
  files: "840K",
  desc: "Curated legal expertise, monetized to third parties without losing control.",
  certified: false
}, {
  slug: "opscidia",
  name: "Opscidia Open Science",
  source: "Opscidia",
  color: 1,
  cat: "science",
  price: "$0.003",
  files: "5.4M",
  desc: "Open-access research corpus with structured metadata and full text.",
  certified: true
}, {
  slug: "art-et-droit",
  name: "Art & Droit",
  source: "Art et Droit",
  color: 6,
  cat: "cultural",
  price: "$0.015",
  files: "120K",
  desc: "Cultural-heritage and art-law archive, licensed for inference.",
  certified: false
}, {
  slug: "france-digitale",
  name: "France Digitale Reports",
  source: "France Digitale",
  color: 7,
  cat: "media",
  price: "$0.008",
  files: "48K",
  desc: "Annual ecosystem reports and startup datasets for the French tech scene.",
  certified: true
}];
function CatTag({
  cat
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: "cat-tag"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "tag",
    size: 11
  }), cat);
}
function DatasetCard({
  d,
  onOpen
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "ds-card ds-card--link dataset-card",
    onClick: () => onOpen(d)
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-top"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dc-source"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dc-square",
    style: {
      background: `var(--dataset-${d.color})`
    }
  }), d.source), /*#__PURE__*/React.createElement("div", {
    className: "dc-badges"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-badge ds-badge--outline ds-badge--sm"
  }, "Open License"), d.certified && /*#__PURE__*/React.createElement("span", {
    className: "ds-badge ds-badge--success ds-badge--sm"
  }, "Certified"))), /*#__PURE__*/React.createElement("div", {
    className: "ds-card__title dc-name",
    style: {
      color: `var(--dataset-${d.color})`
    }
  }, d.name), /*#__PURE__*/React.createElement("div", {
    className: "ds-card__desc dc-desc"
  }, d.desc)), /*#__PURE__*/React.createElement("div", {
    className: "ds-card__footer dc-foot"
  }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement(Icon, {
    name: "tag",
    size: 12
  }), d.price, "/req"), /*#__PURE__*/React.createElement("span", {
    className: "dot"
  }, "\xB7"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement(Icon, {
    name: "database",
    size: 12
  }), d.files, " files"), /*#__PURE__*/React.createElement("span", {
    className: "dot"
  }, "\xB7"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement(Icon, {
    name: "calendar",
    size: 12
  }), "updated 2d ago")));
}
function Marketplace({
  onOpen
}) {
  const [q, setQ] = React.useState("");
  const list = DATASETS.filter(d => d.name.toLowerCase().includes(q.toLowerCase()));
  return /*#__PURE__*/React.createElement("div", {
    className: "screen"
  }, /*#__PURE__*/React.createElement("div", {
    className: "screen-head"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "mono-eyebrow"
  }, "Marketplace \xB7 Science"), /*#__PURE__*/React.createElement("h1", {
    className: "screen-title"
  }, "Premium datasets")), /*#__PURE__*/React.createElement("div", {
    className: "head-actions"
  }, /*#__PURE__*/React.createElement("div", {
    className: "search"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "search",
    size: 16,
    style: {
      color: "var(--muted-foreground)"
    }
  }), /*#__PURE__*/React.createElement("input", {
    className: "search-input",
    placeholder: "Search datasets",
    value: q,
    onChange: e => setQ(e.target.value)
  })), /*#__PURE__*/React.createElement("button", {
    className: "ds-btn ds-btn--outline"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "sliders-horizontal",
    size: 16
  }), "Filters"))), /*#__PURE__*/React.createElement("div", {
    className: "dataset-grid"
  }, list.map(d => /*#__PURE__*/React.createElement(DatasetCard, {
    key: d.slug,
    d: d,
    onOpen: onOpen
  }))));
}
function Stat({
  label,
  value,
  sub
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "ds-card stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__content"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-label"
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "stat-value"
  }, value), sub && /*#__PURE__*/React.createElement("div", {
    className: "stat-sub"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "trending-up",
    size: 12
  }), sub)));
}
function DatasetDetail({
  d,
  onBack
}) {
  const [live, setLive] = React.useState(true);
  const [tab, setTab] = React.useState("overview");
  return /*#__PURE__*/React.createElement("div", {
    className: "screen"
  }, /*#__PURE__*/React.createElement("button", {
    className: "back",
    onClick: onBack
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "arrow-left",
    size: 15
  }), "Marketplace"), /*#__PURE__*/React.createElement("div", {
    className: "detail-head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dc-square lg",
    style: {
      background: `var(--dataset-${d.color})`
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "mono-eyebrow"
  }, d.source, " \xB7 ", d.cat), /*#__PURE__*/React.createElement("h1", {
    className: "screen-title",
    style: {
      color: `var(--dataset-${d.color})`
    }
  }, d.name), /*#__PURE__*/React.createElement("p", {
    className: "detail-desc"
  }, d.desc)), /*#__PURE__*/React.createElement("div", {
    className: "detail-cta"
  }, /*#__PURE__*/React.createElement("button", {
    className: "ds-btn ds-btn--primary"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plug",
    size: 16
  }), "Connect via MCP"), /*#__PURE__*/React.createElement("div", {
    className: "live-row"
  }, /*#__PURE__*/React.createElement("button", {
    className: "ds-switch" + (live ? "" : ""),
    role: "switch",
    "aria-checked": live,
    "data-state": live ? "checked" : "unchecked",
    onClick: () => setLive(!live)
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-switch__thumb"
  })), /*#__PURE__*/React.createElement("span", null, "Streaming ", live ? "live" : "paused")))), /*#__PURE__*/React.createElement("div", {
    className: "stat-row"
  }, /*#__PURE__*/React.createElement(Stat, {
    label: "Queries (30d)",
    value: "48,210",
    sub: "+12% vs prev"
  }), /*#__PURE__*/React.createElement(Stat, {
    label: "Revenue (30d)",
    value: "\u20AC192.84",
    sub: "+8% vs prev"
  }), /*#__PURE__*/React.createElement(Stat, {
    label: "Avg latency",
    value: "142 ms"
  }), /*#__PURE__*/React.createElement(Stat, {
    label: "Files",
    value: d.files
  })), /*#__PURE__*/React.createElement("div", {
    className: "ds-tabs detail-tabs"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-tabs__list"
  }, /*#__PURE__*/React.createElement("button", {
    className: "ds-tabs__trigger",
    "data-state": tab === "overview" ? "active" : "inactive",
    onClick: () => setTab("overview")
  }, "Overview"), /*#__PURE__*/React.createElement("button", {
    className: "ds-tabs__trigger",
    "data-state": tab === "access" ? "active" : "inactive",
    onClick: () => setTab("access")
  }, "Access"), /*#__PURE__*/React.createElement("button", {
    className: "ds-tabs__trigger",
    "data-state": tab === "pricing" ? "active" : "inactive",
    onClick: () => setTab("pricing")
  }, "Pricing"))), tab === "overview" && /*#__PURE__*/React.createElement("div", {
    className: "ds-card panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__content"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "panel-h"
  }, "How this dataset is used"), /*#__PURE__*/React.createElement("ul", {
    className: "check-list"
  }, /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 15
  }), "Streamed for ", /*#__PURE__*/React.createElement("strong", null, "inference only"), " \u2014 never stored, never copied, never used for training."), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 15
  }), "Every query is metered, traced and billed at the price you set."), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 15
  }), "Data never leaves your infrastructure \u2014 the connector runs inside your firewall.")))), tab === "access" && /*#__PURE__*/React.createElement("div", {
    className: "ds-card panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__content"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "panel-h"
  }, "Authorized consumers"), /*#__PURE__*/React.createElement("p", {
    className: "muted-p"
  }, "3 AI platforms have active access. Every access is logged and revocable per dataset."))), tab === "pricing" && /*#__PURE__*/React.createElement("div", {
    className: "ds-card panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__content"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "panel-h"
  }, "Pay-per-use"), /*#__PURE__*/React.createElement("p", {
    className: "muted-p"
  }, "Consumers pay ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: "var(--foreground)"
    }
  }, d.price), " per query on a streaming model \u2014 they pay only for what they consume."))));
}
function bars() {
  return [38, 52, 41, 60, 72, 55, 68, 80, 62, 90, 74, 84];
}
function Consumption() {
  const [tab, setTab] = React.useState("overview");
  return /*#__PURE__*/React.createElement("div", {
    className: "screen"
  }, /*#__PURE__*/React.createElement("h1", {
    className: "screen-title"
  }, "Consumption"), /*#__PURE__*/React.createElement("div", {
    className: "ds-tabs detail-tabs"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-tabs__list"
  }, /*#__PURE__*/React.createElement("button", {
    className: "ds-tabs__trigger",
    "data-state": tab === "overview" ? "active" : "inactive",
    onClick: () => setTab("overview")
  }, "Overview"), /*#__PURE__*/React.createElement("button", {
    className: "ds-tabs__trigger",
    "data-state": tab === "billing" ? "active" : "inactive",
    onClick: () => setTab("billing")
  }, "Billing"))), /*#__PURE__*/React.createElement("div", {
    className: "stat-row"
  }, /*#__PURE__*/React.createElement(Stat, {
    label: "Queries (30d)",
    value: "312,940",
    sub: "+18%"
  }), /*#__PURE__*/React.createElement(Stat, {
    label: "Revenue (30d)",
    value: "\u20AC1,284.20",
    sub: "+11%"
  }), /*#__PURE__*/React.createElement(Stat, {
    label: "Active datasets",
    value: "6"
  }), /*#__PURE__*/React.createElement(Stat, {
    label: "Consumers",
    value: "14"
  })), /*#__PURE__*/React.createElement("div", {
    className: "ds-card panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__content"
  }, /*#__PURE__*/React.createElement("div", {
    className: "chart-head"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "panel-h",
    style: {
      margin: 0
    }
  }, "Queries per month"), /*#__PURE__*/React.createElement("span", {
    className: "ds-badge ds-badge--outline ds-badge--sm"
  }, "Last 12 months")), /*#__PURE__*/React.createElement("div", {
    className: "chart"
  }, bars().map((h, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "bar-wrap"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bar",
    style: {
      height: h + "%"
    }
  })))))));
}
const ENDPOINTS = [{
  m: "GET",
  p: "/v1/datasets",
  d: "List datasets you can stream"
}, {
  m: "POST",
  p: "/v1/query",
  d: "Run a metered inference query"
}, {
  m: "GET",
  p: "/v1/datasets/{slug}/schema",
  d: "Fetch dataset schema"
}, {
  m: "POST",
  p: "/v1/access/grant",
  d: "Grant a consumer access"
}, {
  m: "DELETE",
  p: "/v1/access/{id}",
  d: "Revoke access (logged)"
}];
function MCP() {
  return /*#__PURE__*/React.createElement("div", {
    className: "screen"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mono-eyebrow"
  }, "My Outputs"), /*#__PURE__*/React.createElement("h1", {
    className: "screen-title"
  }, "MCP endpoint"), /*#__PURE__*/React.createElement("div", {
    className: "ds-card panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__content endpoint-url"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plug",
    size: 16,
    style: {
      color: "var(--primary)"
    }
  }), /*#__PURE__*/React.createElement("code", null, "https://mcp.alien.is/ti-publisher"), /*#__PURE__*/React.createElement("button", {
    className: "ds-btn ds-btn--ghost ds-btn--sm",
    style: {
      marginLeft: "auto"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "copy",
    size: 14
  }), "Copy"))), /*#__PURE__*/React.createElement("div", {
    className: "ds-card panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__content"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "panel-h"
  }, "Available methods"), /*#__PURE__*/React.createElement("div", {
    className: "endpoint-list"
  }, ENDPOINTS.map((e, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "endpoint-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-badge ds-badge--sm ds-method ds-method--" + e.m.toLowerCase()
  }, e.m), /*#__PURE__*/React.createElement("code", {
    className: "ep-path"
  }, e.p), /*#__PURE__*/React.createElement("span", {
    className: "ep-desc"
  }, e.d)))))));
}
const CHECKLIST = [{
  title: "Create a cluster",
  desc: "Set up your first data space to organize and manage your content.",
  done: true
}, {
  title: "Import your datasets",
  desc: "Upload your files and connect your data sources to the platform.",
  done: true
}, {
  title: "Configure a workflow or MCP",
  desc: "Expose your content to AI platforms in real time, on your terms.",
  done: false
}, {
  title: "Optimize & manage",
  desc: "Monitor streams, fine-tune access rules, keep full control of your data.",
  done: false
}];
function Dashboard({
  onNavigate
}) {
  const [range, setRange] = React.useState("24h");
  const done = CHECKLIST.filter(s => s.done).length;
  const pct = Math.round(done / CHECKLIST.length * 100);
  return /*#__PURE__*/React.createElement("div", {
    className: "screen dash"
  }, /*#__PURE__*/React.createElement("div", {
    className: "screen-head"
  }, /*#__PURE__*/React.createElement("h1", {
    className: "screen-title"
  }, "Dashboard"), /*#__PURE__*/React.createElement("div", {
    className: "ds-segmented"
  }, ["24h", "7d", "30d", "All"].map(r => /*#__PURE__*/React.createElement("button", {
    key: r,
    className: "ds-segmented__item",
    "aria-pressed": range === r,
    onClick: () => setRange(r)
  }, r)))), /*#__PURE__*/React.createElement("div", {
    className: "dash-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dash-main"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat-row",
    style: {
      gridTemplateColumns: "1fr 1fr"
    }
  }, /*#__PURE__*/React.createElement(StatCardEl, {
    label: "Total Revenue",
    icon: "banknote",
    value: "\u20AC12,840",
    delta: "+20.1% from last month",
    spark: [10, 14, 12, 18, 22, 19, 26, 24, 30, 28, 34]
  }), /*#__PURE__*/React.createElement(StatCardEl, {
    label: "Total Requests",
    icon: "wallet",
    value: "312,940",
    delta: "+18% from last month",
    spark: [8, 9, 13, 11, 16, 20, 18, 24, 22, 28, 31]
  })), /*#__PURE__*/React.createElement("div", {
    className: "dash-cols"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__content"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "panel-h"
  }, "Top Consumers"), /*#__PURE__*/React.createElement("div", {
    className: "ds-table-wrap",
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("table", {
    className: "ds-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Consumer"), /*#__PURE__*/React.createElement("th", {
    className: "num"
  }, "Requests"), /*#__PURE__*/React.createElement("th", {
    className: "num"
  }, "Spend"))), /*#__PURE__*/React.createElement("tbody", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "t-org"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dc-square",
    style: {
      background: "var(--dataset-2)"
    }
  }), "Anthropic")), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, "124,300"), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, "\u20AC497.20")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "t-org"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dc-square",
    style: {
      background: "var(--dataset-4)"
    }
  }), "Mistral")), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, "89,100"), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, "\u20AC356.40")), /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "t-org"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dc-square",
    style: {
      background: "var(--dataset-3)"
    }
  }), "OpenAI")), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, "63,000"), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, "\u20AC252.00"))))))), /*#__PURE__*/React.createElement("div", {
    className: "ds-card panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__content"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "panel-h"
  }, "Top Datasets"), /*#__PURE__*/React.createElement("div", {
    className: "ds-empty",
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-empty__icon"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "database",
    size: 28,
    strokeWidth: 1.6
  })), /*#__PURE__*/React.createElement("span", {
    className: "ds-empty__title"
  }, "No datasets yet."), /*#__PURE__*/React.createElement("span", {
    className: "ds-empty__desc"
  }, "Import your first dataset to start tracking usage and performance."), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "ds-btn ds-btn--outline ds-btn--sm",
    onClick: () => onNavigate("marketplace")
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plus",
    size: 15
  }), "Import datasets")))))), /*#__PURE__*/React.createElement("div", {
    className: "ds-card talk"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__content talk-inner"
  }, /*#__PURE__*/React.createElement("span", {
    className: "talk-ic"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "message-circle-question",
    size: 22
  })), /*#__PURE__*/React.createElement("div", {
    className: "talk-copy"
  }, /*#__PURE__*/React.createElement("div", {
    className: "talk-h"
  }, "Got questions or suggestions?"), /*#__PURE__*/React.createElement("div", {
    className: "talk-p"
  }, "We'd love to hear from you. Help us build the platform you need.")), /*#__PURE__*/React.createElement("button", {
    className: "ds-btn ds-btn--secondary ds-btn--sm"
  }, "Talk to us")))), /*#__PURE__*/React.createElement("aside", {
    className: "ds-card getting-started"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-card__content"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-checklist__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-checklist__title"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "flame",
    size: 16,
    style: {
      color: "var(--warning)"
    }
  }), "Getting Started"), /*#__PURE__*/React.createElement("span", {
    className: "ds-checklist__progress"
  }, pct, "% completed")), /*#__PURE__*/React.createElement("div", {
    className: "ds-checklist__bar",
    style: {
      margin: "12px 0 18px"
    }
  }, /*#__PURE__*/React.createElement("i", {
    style: {
      width: pct + "%"
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "ds-checklist"
  }, CHECKLIST.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "ds-step" + (s.done ? " is-done" : "")
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-step__check"
  }, s.done && /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 12,
    strokeWidth: 3
  })), /*#__PURE__*/React.createElement("div", {
    className: "ds-step__body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-step__title"
  }, i + 1, ". ", s.title), /*#__PURE__*/React.createElement("span", {
    className: "ds-step__desc"
  }, s.desc)))))))));
}
function StatCardEl({
  label,
  value,
  icon,
  delta,
  spark
}) {
  const max = Math.max(...spark),
    min = Math.min(...spark);
  const pts = spark.map((v, i) => `${i / (spark.length - 1) * 100},${26 - (v - min) / (max - min || 1) * 24}`).join(" ");
  const down = delta.trim().startsWith("-");
  return /*#__PURE__*/React.createElement("div", {
    className: "ds-stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ds-stat__top"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ds-stat__label"
  }, label), /*#__PURE__*/React.createElement("span", {
    className: "ds-stat__icon"
  }, /*#__PURE__*/React.createElement(Icon, {
    name: icon,
    size: 16
  }))), /*#__PURE__*/React.createElement("div", {
    className: "ds-stat__value"
  }, value), /*#__PURE__*/React.createElement("span", {
    className: "ds-stat__delta " + (down ? "ds-stat__delta--down" : "ds-stat__delta--up")
  }, /*#__PURE__*/React.createElement(Icon, {
    name: down ? "trending-down" : "trending-up",
    size: 12
  }), delta), /*#__PURE__*/React.createElement("svg", {
    className: "ds-stat__spark",
    viewBox: "0 0 100 28",
    width: "100%",
    height: "28",
    preserveAspectRatio: "none"
  }, /*#__PURE__*/React.createElement("polyline", {
    fill: "none",
    stroke: "var(--brand-teal)",
    strokeWidth: "1.5",
    points: pts
  })));
}
Object.assign(window, {
  Marketplace,
  DatasetDetail,
  Consumption,
  MCP,
  Dashboard,
  DATASETS
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web-app/screens.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.MethodBadge = __ds_scope.MethodBadge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.CardHeader = __ds_scope.CardHeader;

__ds_ns.CardTitle = __ds_scope.CardTitle;

__ds_ns.CardDescription = __ds_scope.CardDescription;

__ds_ns.CardContent = __ds_scope.CardContent;

__ds_ns.CardFooter = __ds_scope.CardFooter;

__ds_ns.StatCard = __ds_scope.StatCard;

__ds_ns.Table = __ds_scope.Table;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.TabsList = __ds_scope.TabsList;

__ds_ns.TabsTrigger = __ds_scope.TabsTrigger;

__ds_ns.TabsContent = __ds_scope.TabsContent;

__ds_ns.EmptyState = __ds_scope.EmptyState;

__ds_ns.Tooltip = __ds_scope.Tooltip;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.SegmentedControl = __ds_scope.SegmentedControl;

})();
