{
  config,
  dashboarddPackages,
  lib,
  pkgs,
  ...
}:
let
  server = config.programs.dashboardd;
  desktop = config.programs.dashboardd-desktop;
  widgetPath =
    package: packages: lib.makeSearchPath "share/dashboardd/widgets" ([ package ] ++ packages);
  environment = values: lib.mapAttrsToList (name: value: "${name}=${value}") values;
in
{
  options.programs.dashboardd = {
    enable = lib.mkEnableOption "the Dashboardd browser host";
    package = lib.mkOption {
      type = lib.types.package;
      default = dashboarddPackages.server;
      defaultText = lib.literalExpression "inputs.dashboardd.packages.${pkgs.system}.dashboardd";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 8000;
    };
    autoStart = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Start the browser host with the user session.";
    };
    widgetPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
    };
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
    };
  };

  options.programs.dashboardd-desktop = {
    enable = lib.mkEnableOption "the Dashboardd native widget host";
    package = lib.mkOption {
      type = lib.types.package;
      default = dashboarddPackages.desktop;
      defaultText = lib.literalExpression "inputs.dashboardd.packages.${pkgs.system}.dashboardd-desktop";
    };
    autoStart = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Start the native host with the user session.";
    };
    widgetPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
    };
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
    };
  };

  config = lib.mkMerge [
    (lib.mkIf server.enable {
      home.packages = [ server.package ];
      systemd.user.services.dashboardd = {
        Unit = {
          Description = "Dashboardd browser host";
          After = [ "network.target" ];
        };
        Service = {
          ExecStart = "${server.package}/bin/dashboardd";
          Restart = "on-failure";
          RestartSec = 2;
          Environment = [
            "DASHBOARDD_PORT=${toString server.port}"
            "DASHBOARDD_WIDGET_PATH=${widgetPath server.package server.widgetPackages}"
          ]
          ++ environment server.environment;
        };
        Install.WantedBy = lib.optionals server.autoStart [ "default.target" ];
      };
    })
    (lib.mkIf desktop.enable {
      home.packages = [ desktop.package ];
      systemd.user.services.dashboardd-desktop = {
        Unit = {
          Description = "Dashboardd native widget host";
          After = [ "graphical-session.target" ];
        };
        Service = {
          ExecStart = "${desktop.package}/bin/dashboardd-desktop";
          Restart = "on-failure";
          RestartSec = 2;
          Environment = [
            "DASHBOARDD_WIDGET_PATH=${widgetPath desktop.package desktop.widgetPackages}"
          ]
          ++ environment desktop.environment;
        };
        Install.WantedBy = lib.optionals desktop.autoStart [ "default.target" ];
      };
    })
  ];
}
